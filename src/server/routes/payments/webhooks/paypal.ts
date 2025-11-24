/**
 * PayPal webhook handler.
 *
 * Uses payments adapters to verify and normalize events, records them in payments_events,
 * and grants/revokes entitlements based on the normalized type.
 */

import { Router, type Request, type Response } from "express";
import { parseWebhook as parsePayPalWebhook, planMeta } from "../../../../lib/payments";
import { createClient } from "../../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../../lib/logger";
import type { PlanKey } from "../../../../lib/constants";

const router = Router();
const supabase = createClient();

router.post("/", (req: RequestWithRawBody, res: Response): void => {
  void handlePayPalWebhook(req, res);
});

export default router;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type Provider = "paypal";

interface RequestWithRawBody extends Request {
  rawBody?: string;
}

type PayPalEvent = Awaited<ReturnType<typeof parsePayPalWebhook>>[number];

function normalizeHeaders(
  h: Request["headers"],
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (Array.isArray(v)) {
      out[k] = v.map(String);
    } else if (v != null) {
      out[k] = String(v);
    }
  }
  return out;
}

async function recordEvent(ev: PayPalEvent) {
  try {
    await supabase.from("payments_events").insert({
      provider: ev.provider,
      provider_ref: ev.id,
      status: ev.type,
      plan: ev.plan_key ?? null,
      user_id: ev.user_hint ?? null,
      amount_minor: ev.amount_cents ?? null,
      currency: ev.currency ?? null,
      raw: ev.raw,
    });
  } catch (error) {
    log.warn("recordEvent failed", { err: safeError(error), provider: ev.provider });
  }
}

async function grantEntitlement(
  userId?: string | null,
  plan?: string | null,
  source?: Provider,
  reference?: string,
) {
  if (!userId) return;
  const planKey = ensurePlanKey(plan);
  if (!planKey) return;
  const tier = planMeta(planKey).tier;

  try {
    const { error } = await supabase.rpc("grant_entitlement", {
      p_user_id: userId,
      p_tier: tier,
      p_source: source,
      p_reference: reference,
    });
    if (!error) return;
  } catch {
    // ignore
  }

  await supabase.from("entitlements").upsert(
    {
      user_id: userId,
      plan: planKey,
      active: true,
      source: source ?? null,
      reference: reference ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,plan" },
  );
}

async function revokeEntitlement(
  userId?: string | null,
  source?: Provider,
  reference?: string,
) {
  if (!userId) return;

  try {
    const { error } = await supabase.rpc("revoke_entitlement", {
      p_user_id: userId,
      p_source: source,
      p_reference: reference,
    });
    if (!error) return;
  } catch {
    // ignore
  }

  await supabase
    .from("entitlements")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
}

async function handlePayPalWebhook(req: RequestWithRawBody, res: Response): Promise<void> {
  await runWithRequestContext({ headers: req.headers }, async () => {
    try {
      const rawBody =
        typeof req.rawBody === "string" ? req.rawBody : JSON.stringify(req.body ?? {});
      const headers = normalizeHeaders(req.headers);

      const events = await parsePayPalWebhook({ headers, rawBody }, "paypal");

      for (const ev of events) {
        await recordEvent(ev);

        if (
          ev.type === "payment_succeeded" ||
          ev.type === "subscription_created" ||
          ev.type === "subscription_updated"
        ) {
          await grantEntitlement(ev.user_hint, ev.plan_key, "paypal", ev.id);
        } else if (ev.type === "payment_refunded" || ev.type === "subscription_canceled") {
          await revokeEntitlement(ev.user_hint, "paypal", ev.id);
        }
      }

      res.status(200).json({ ok: true, correlation_id: getCorrelationId() });
    } catch (error) {
      log.error("paypal webhook error", { err: safeError(error) });
      res
        .status(400)
        .json({ ok: false, error: (error as Error).message, correlation_id: getCorrelationId() });
    }
  });
}

function ensurePlanKey(plan?: string | null): PlanKey | null {
  if (!plan) return null;
  if (
    plan === "pro_monthly" ||
    plan === "pro_yearly" ||
    plan === "vip_monthly" ||
    plan === "vip_yearly"
  ) {
    return plan;
  }
  return null;
}
