// polaris-core/src/server/routes/affiliates/signup-attach.ts
import type { Request, Response } from "express";
import { Router } from "express";
import { createClient } from "../../../lib/supabase";

const router = Router();
const supabase = createClient();

interface SignupAttachBody {
  userId?: string;
  affiliateId?: string;
  affiliateCode?: string;
  utmSource?: string;
  utmCampaign?: string;
  utmMedium?: string;
  clickId?: string;
  reference?: string;
}

type SignupAttachRequest = Request<unknown, unknown, Partial<SignupAttachBody>>;

interface AffiliateSummary {
  id: string;
  code?: string | null;
}

interface ReferralExistingRow {
  id: string;
  status: string;
}

interface ReferralInsertRow {
  id: string;
}

interface AffiliateLookupRow {
  id: string | number;
  code?: string | null;
}

interface ReferralClickRow {
  affiliate_id: string | number | null;
  affiliate_code?: string | null;
}

/**
 * Polaris Core — Attach a new signup to an affiliate
 *
 * POST /affiliates/signup-attach
 * Body:
 *  - userId: string                       // required
 *  - affiliateId?: string                 // preferred if you have it
 *  - affiliateCode?: string               // fallback if you only have a public code
 *  - utmSource?: string
 *  - utmCampaign?: string
 *  - utmMedium?: string
 *  - clickId?: string                     // optional click id from /affiliates/click
 *  - reference?: string                   // optional payment ref if already known
 *
 * Behavior:
 *  1) Resolve affiliate by id or code.
 *  2) If a referral row already exists for this user and affiliate with status in
 *     ["pending", "clicked", "attached", "qualified"], return idempotently.
 *  3) Otherwise insert a referral row with status "pending" and attached_at timestamp.
 *  4) Returns { ok, referralId, affiliate: { id, code } }.
 */

const handleSignupAttach = async (req: SignupAttachRequest, res: Response): Promise<void> => {
  try {
    const body: Partial<SignupAttachBody> = req.body ?? {};
    const userId = typeof body.userId === "string" ? body.userId : undefined;
    const bodyAffiliateId =
      typeof body.affiliateId === "string" && body.affiliateId.length > 0 ? body.affiliateId : undefined;
    const affiliateCode =
      typeof body.affiliateCode === "string" && body.affiliateCode.length > 0 ? body.affiliateCode : undefined;
    const utmSource = typeof body.utmSource === "string" ? body.utmSource : undefined;
    const utmCampaign = typeof body.utmCampaign === "string" ? body.utmCampaign : undefined;
    const utmMedium = typeof body.utmMedium === "string" ? body.utmMedium : undefined;
    const clickId = typeof body.clickId === "string" ? body.clickId : undefined;
    const reference = typeof body.reference === "string" ? body.reference : undefined;

    if (!userId) {
      res.status(400).json({ error: "missing_userId" });
      return;
    }

    // Resolve affiliate
    const affiliate =
      (await resolveAffiliateFromBody(bodyAffiliateId, affiliateCode)) ||
      (await resolveAffiliateFromLatestClick(userId)) ||
      null;

    if (!affiliate) {
      res.status(200).json({ ok: false, reason: "unknown_affiliate" });
      return;
    }

    const refTable = await ensureReferralsTable();
    if (!refTable) {
      res.status(500).json({ error: "referrals_table_missing" });
      return;
    }

    const nowIso = new Date().toISOString();

    // Idempotency: if a row already exists for this user and affiliate, return it
    const { data: existing, error: existErr } = await supabase
      .from(refTable)
      .select("id, status")
      .eq("user_id", userId)
      .eq("affiliate_id", affiliate.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<ReferralExistingRow>();

    if (!existErr && existing) {
      // Optionally update metadata if it is missing
      const metadataUpdate = {
        affiliate_code: affiliate.code ?? null,
        last_payment_ref: reference ?? null,
        utm_source: utmSource ?? undefined,
        utm_campaign: utmCampaign ?? undefined,
        utm_medium: utmMedium ?? undefined,
        click_id: clickId ?? undefined,
        updated_at: nowIso,
      } satisfies Record<string, string | null | undefined>;

      await supabase
        .from(refTable)
        .update(metadataUpdate)
        .eq("id", existing.id);

      res.status(200).json({
        ok: true,
        idempotent: true,
        referralId: existing.id,
        affiliate: { id: affiliate.id, code: affiliate.code ?? null },
        status: existing.status,
      });
      return;
    }

    // Insert new pending referral attached at signup
    const insertPayload = {
      user_id: userId,
      affiliate_id: affiliate.id,
      affiliate_code: affiliate.code ?? null,
      status: "pending",
      attached_at: nowIso,
      last_payment_ref: reference ?? null,
      utm_source: utmSource ?? null,
      utm_campaign: utmCampaign ?? null,
      utm_medium: utmMedium ?? null,
      click_id: clickId ?? null,
      created_at: nowIso,
      updated_at: nowIso,
    } satisfies Record<string, string | null>;

    const { data: ins, error: insErr } = await supabase
      .from(refTable)
      .insert(insertPayload)
      .select("id")
      .maybeSingle<ReferralInsertRow>();

    if (insErr || !ins) {
      res.status(500).json({ error: "insert_failed", detail: safeMsg(insErr?.message) });
      return;
    }

    res.status(200).json({
      ok: true,
      referralId: ins.id,
      affiliate: { id: affiliate.id, code: affiliate.code ?? null },
      status: "pending",
    });
    return;
  } catch (err: any) {
    console.error("[affiliates/signup-attach] error", err);
    res.status(500).json({ error: "internal_error" });
    return;
  }
};

router.post("/", (req: Request, res: Response) => {
  void handleSignupAttach(req as SignupAttachRequest, res);
});

export default router;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function resolveAffiliateFromBody(
  affiliateId?: string,
  affiliateCode?: string,
): Promise<AffiliateSummary | null> {
  if (affiliateId) return { id: String(affiliateId) };

  if (affiliateCode) {
    const table = await ensureAffiliatesTable();
    if (!table) return null;
    const { data, error } = await supabase
      .from(table)
      .select("id, code")
      .eq("code", affiliateCode)
      .limit(1)
      .maybeSingle<AffiliateLookupRow>();
    if (!error && data?.id) {
      return { id: String(data.id), code: data.code ?? undefined };
    }
  }
  return null;
}

// If you store the most recent click in affiliate_referrals with status "clicked",
// you can try to infer the affiliate for a user who signs up right after a click.
async function resolveAffiliateFromLatestClick(userId: string): Promise<AffiliateSummary | null> {
  const refTable = await ensureReferralsTable();
  if (!refTable) return null;
  const { data, error } = await supabase
    .from(refTable)
    .select("affiliate_id, affiliate_code")
    .eq("user_id", userId)
    .eq("status", "clicked")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<ReferralClickRow>();
  if (error || !data || !data.affiliate_id) return null;
  return {
    id: String(data.affiliate_id),
    code: data.affiliate_code ?? undefined,
  };
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
      // keep trying
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
      // keep trying
    }
  }
  return null;
}

function safeMsg(msg?: string) {
  return String(msg || "").replace(/\s+/g, " ").slice(0, 200);
}
