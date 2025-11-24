// polaris-core/src/server/routes/auth/callback.ts
import type { Request, Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { Router } from "express";
import { createClient } from "../../../lib/supabase";

const router = Router();
const supabase = createClient();

interface CallbackQuery {
  redirect?: string;
  userId?: string;
  affiliateId?: string;
  affiliateCode?: string;
  aff?: string;
  clickId?: string;
  utm_source?: string;
  utm_campaign?: string;
  utm_medium?: string;
}

interface CallbackBody {
  userId?: string;
  affiliateId?: string;
  affiliateCode?: string;
  clickId?: string;
  utmSource?: string;
  utmCampaign?: string;
  utmMedium?: string;
}

interface AffiliateRow {
  id: string | number;
  code?: string | null;
}

interface ReferralRow {
  id: string;
  status: string;
}

type CallbackRequest = Request<ParamsDictionary, unknown, unknown, CallbackQuery>;
type CallbackPostRequest = Request<ParamsDictionary, unknown, CallbackBody>;

/**
 * Polaris Core — Auth callback bridge
 *
 * - Associates any affiliate info to the user if provided
 * - Logs a lightweight "auth_callback" event
 * - Redirects back to the app, or returns JSON for XHR calls
 *
 * GET  /auth/callback?redirect=/dashboard&affiliateCode=XYZ&clickId=abc123
 * HEADERS: x-user-id: <uuid>
 */

const handleGetCallback = async (req: CallbackRequest, res: Response): Promise<void> => {
  try {
    const query: CallbackQuery = req.query || {};
    const redirect =
      typeof query.redirect === "string" && query.redirect.length > 0 ? query.redirect : "/dashboard";

    // Resolve user id from header first, then query
    const headerUserId = req.header("x-user-id");
    const queryUserId = typeof query.userId === "string" ? query.userId : undefined;
    const userId = (headerUserId && headerUserId.trim()) || (queryUserId && queryUserId.trim()) || undefined;
    if (!userId) {
      res.status(400).send("Missing user id. Provide x-user-id header or userId query.");
      return;
    }

    // Optional affiliate params
    const affiliateId = typeof query.affiliateId === "string" ? query.affiliateId : undefined;
    const affiliateCode =
      typeof query.affiliateCode === "string"
        ? query.affiliateCode
        : typeof query.aff === "string"
          ? query.aff
          : undefined;
    const clickId = typeof query.clickId === "string" ? query.clickId : undefined;

    const utmSource = typeof query.utm_source === "string" ? query.utm_source : undefined;
    const utmCampaign = typeof query.utm_campaign === "string" ? query.utm_campaign : undefined;
    const utmMedium = typeof query.utm_medium === "string" ? query.utm_medium : undefined;

    // 1) Attach or update affiliate referral if any hint exists
    if (affiliateId || affiliateCode || clickId) {
      await upsertReferral({
        userId,
        affiliateId,
        affiliateCode,
        clickId,
        utmSource,
        utmCampaign,
        utmMedium,
      });
    }

    // 2) Log a tiny event for analytics if the table exists
    await logAuthEvent(userId, {
      affiliateId,
      affiliateCode,
      clickId,
      utmSource,
      utmCampaign,
      utmMedium,
    });

    // 3) Redirect back to the app
    const appBase =
      process.env.NEXT_PUBLIC_APP_BASE_URL ||
      process.env.APP_BASE_URL ||
      "http://localhost:3000";

    const url = new URL(redirect.startsWith("http") ? redirect : `${appBase}${redirect}`);
    res.redirect(302, url.toString());
    return;
  } catch (err: any) {
    console.error("[auth/callback] error", err);
    res.status(500).send("internal_error");
    return;
  }
};

// Optional POST variant for XHR calls
const handlePostCallback = async (req: CallbackPostRequest, res: Response): Promise<void> => {
  try {
    const headerUserId = req.header("x-user-id")?.trim();
    const body = (req.body && typeof req.body === "object" ? (req.body as Partial<CallbackBody>) : {}) ?? {};
    const bodyUserId = typeof body.userId === "string" ? body.userId.trim() : undefined;
    const userId = headerUserId || bodyUserId;
    if (!userId) {
      res.status(400).json({ error: "missing_userId" });
      return;
    }

    const affiliateId = typeof body.affiliateId === "string" ? body.affiliateId : undefined;
    const affiliateCode = typeof body.affiliateCode === "string" ? body.affiliateCode : undefined;
    const clickId = typeof body.clickId === "string" ? body.clickId : undefined;
    const utmSource = typeof body.utmSource === "string" ? body.utmSource : undefined;
    const utmCampaign = typeof body.utmCampaign === "string" ? body.utmCampaign : undefined;
    const utmMedium = typeof body.utmMedium === "string" ? body.utmMedium : undefined;

    if (affiliateId || affiliateCode || clickId) {
      await upsertReferral({
        userId,
        affiliateId,
        affiliateCode,
        clickId,
        utmSource,
        utmCampaign,
        utmMedium,
      });
    }

    await logAuthEvent(userId, {
      affiliateId,
      affiliateCode,
      clickId,
      utmSource,
      utmCampaign,
      utmMedium,
    });

    res.status(200).json({ ok: true });
    return;
  } catch (err: any) {
    console.error("[auth/callback] error", err);
    res.status(500).json({ error: "internal_error" });
    return;
  }
};

router.get("/", (req: CallbackRequest, res: Response) => {
  void handleGetCallback(req, res);
});

router.post("/", (req: CallbackPostRequest, res: Response) => {
  void handlePostCallback(req, res);
});

export default router;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type ReferralInput = {
  userId: string;
  affiliateId?: string;
  affiliateCode?: string;
  clickId?: string;
  utmSource?: string;
  utmCampaign?: string;
  utmMedium?: string;
};

type ReferralUpdatePayload = {
  affiliate_id?: string;
  affiliate_code?: string | null;
  click_id?: string | null;
  utm_source?: string | null;
  utm_campaign?: string | null;
  utm_medium?: string | null;
  updated_at: string;
  status: string;
};

type ReferralInsertPayload = {
  user_id: string;
  affiliate_id: string | null;
  affiliate_code: string | null;
  click_id: string | null;
  utm_source: string | null;
  utm_campaign: string | null;
  utm_medium: string | null;
  status: string;
  attached_at: string;
  created_at: string;
  updated_at: string;
};

async function upsertReferral(input: ReferralInput) {
  const table = await ensureReferralsTable();
  if (!table) return;

  // Try to resolve affiliate by code if id is missing
  let affiliateId = input.affiliateId;
  let affiliateCode = input.affiliateCode;

  if (!affiliateId && affiliateCode) {
    const affTable = await ensureAffiliatesTable();
    if (affTable) {
      const { data } = await supabase
        .from(affTable)
        .select("id, code")
        .eq("code", affiliateCode)
        .limit(1)
        .maybeSingle<AffiliateRow>();
      if (data?.id) {
        affiliateId = String(data.id);
        affiliateCode = data.code ?? affiliateCode;
      }
    }
  }

  if (!affiliateId && !affiliateCode && !input.clickId) return;

  const nowIso = new Date().toISOString();

  // Try to find existing row to keep the latest status
  const { data: exist } = await supabase
    .from(table)
    .select("id, status")
    .eq("user_id", input.userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<ReferralRow>();

  if (exist) {
    const nextStatus = ["clicked", "pending"].includes(exist.status) ? "attached" : exist.status;
    const updatePayload: ReferralUpdatePayload = {
      affiliate_id: affiliateId ?? undefined,
      affiliate_code: affiliateCode ?? null,
      click_id: input.clickId ?? null,
      utm_source: input.utmSource ?? null,
      utm_campaign: input.utmCampaign ?? null,
      utm_medium: input.utmMedium ?? null,
      updated_at: nowIso,
      status: nextStatus,
    };

    await supabase
      .from(table)
      .update(updatePayload)
      .eq("id", exist.id);
    return;
  }

  // Insert a new row
  const insertPayload: ReferralInsertPayload = {
    user_id: input.userId,
    affiliate_id: affiliateId ?? null,
    affiliate_code: affiliateCode ?? null,
    click_id: input.clickId ?? null,
    utm_source: input.utmSource ?? null,
    utm_campaign: input.utmCampaign ?? null,
    utm_medium: input.utmMedium ?? null,
    status: "attached",
    attached_at: nowIso,
    created_at: nowIso,
    updated_at: nowIso,
  };
  await supabase.from(table).insert(insertPayload);
}

async function logAuthEvent(
  userId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const table = await ensureEventsTable();
  if (!table) return;
  const nowIso = new Date().toISOString();
  const eventPayload = {
    user_id: userId,
    name: "auth_callback",
    meta: meta ?? {},
    created_at: nowIso,
  };
  await supabase.from(table).insert(eventPayload);
}

async function ensureReferralsTable(): Promise<string | null> {
  const candidates = ["affiliate_referrals", "affiliates_referrals", "referrals_affiliates"];
  for (const t of candidates) {
    try {
      const { error } = await supabase
        .from(t)
        .select("*", { head: true, count: "exact" })
        .limit(0);
      if (!error) return t;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

async function ensureAffiliatesTable(): Promise<string | null> {
  const candidates = ["affiliates", "affiliate_accounts"];
  for (const t of candidates) {
    try {
      const { error } = await supabase
        .from(t)
        .select("*", { head: true, count: "exact" })
        .limit(0);
      if (!error) return t;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

async function ensureEventsTable(): Promise<string | null> {
  const candidates = ["events", "app_events"];
  for (const t of candidates) {
    try {
      const { error } = await supabase
        .from(t)
        .select("*", { head: true, count: "exact" })
        .limit(0);
      if (!error) return t;
    } catch {
      /* keep trying */
    }
  }
  return null;
}
