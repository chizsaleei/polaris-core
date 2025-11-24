/**
 * PayMongo webhook endpoint.
 *
 * Verifies the signature, normalizes events using the adapter, records them,
 * and grants or revokes entitlements depending on status.
 */

import { Router, type Request, type Response } from "express";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../../lib/logger";
import { parseWebhook as parsePayMongoWebhook, planMeta } from "../../../../lib/payments";
import type { PlanKey } from "../../../../lib/constants";
import { createClient } from "../../../../lib/supabase";

const router = Router();
const supabase = createClient();

router.post("/", (req: RequestWithRawBody, res: Response): void => {
  void handlePaymongoWebhook(req, res);
});

export default router;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type Provider = "paymongo";

interface RequestWithRawBody extends Request {
  rawBody?: string;
}

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

type PaymongoEvent = Awaited<ReturnType<typeof parsePayMongoWebhook>>[number];

async function recordEvent(ev: PaymongoEvent) {
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
    // ignore, fall through
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
async function handlePaymongoWebhook(req: RequestWithRawBody, res: Response): Promise<void> {
  await runWithRequestContext({ headers: req.headers }, async () => {
    try {
      const rawBody =
        typeof req.rawBody === "string" ? req.rawBody : JSON.stringify(req.body ?? {});
      const headers = normalizeHeaders(req.headers);
      const events = await parsePayMongoWebhook({ headers, rawBody }, "paymongo");

      for (const ev of events) {
        await recordEvent(ev);

        if (ev.type === "payment_succeeded") {
          await grantEntitlement(ev.user_hint, ev.plan_key, "paymongo", ev.id);
        } else if (ev.type === "payment_refunded") {
          await revokeEntitlement(ev.user_hint, "paymongo", ev.id);
        }
      }

      res.status(200).json({ ok: true, correlation_id: getCorrelationId() });
    } catch (error) {
      log.error("paymongo webhook error", { err: safeError(error) });
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
