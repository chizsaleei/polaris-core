// src/server/routes/affiliates/click.ts
// polaris-core/src/server/routes/affiliates/click.ts
import type { IncomingHttpHeaders } from "http";
import { Router, Request, Response } from "express";
import { createClient } from "../../../lib/supabase";
import { randomUUID } from "crypto";

const router = Router();
const supabase = createClient();

/**
 * Records an affiliate click and sets a cookie for 30 days.
 */
const handleAffiliateClick = async (req: Request, res: Response): Promise<void> => {
  try {
    const params = normalizeParams(req);
    if (!params.code) {
      res.status(400).json({ error: "missing_code" });
      return;
    }

    const affiliateId = await resolveAffiliateId(params.code);

    const clickId = randomUUID();
    await supabase.from("affiliate_events").insert({
      event_type: "click",
      code: params.code,
      affiliate_id: affiliateId ?? null,
      user_id: params.userId ?? null,
      campaign: params.campaign ?? null,
      medium: params.medium ?? null,
      source: params.source ?? null,
      landing_url: params.landingUrl ?? null,
      referrer: params.referrer ?? null,
      user_agent: params.ua ?? null,
      ip: params.ip ?? null,
      click_id: clickId,
      created_at: new Date().toISOString(),
      raw: {
        headers: pickHeaders(req.headers, [
          "user-agent",
          "referer",
          "x-forwarded-for",
          "cf-connecting-ip",
          "x-real-ip",
        ]),
      },
    } as any);

    const secure = String(process.env.NODE_ENV) === "production";
    res.cookie("af_code", params.code, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
    });

    const redir = safeRedirect(params.redirect);
    if (redir) {
      res.redirect(302, redir);
      return;
    }

    res.status(200).json({ ok: true, clickId, cookie: true });
    return;
  } catch (err: any) {
    console.error("[affiliates/click] error", err);
    res.status(500).json({ error: "internal_error" });
    return;
  }
};

router.all("/", (req: Request, res: Response) => {
  void handleAffiliateClick(req, res);
});

export default router;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function normalizeParams(req: Request) {
  const q = req.query as Record<string, unknown>;
  const b =
    (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});

  const get = <T = string>(k: string): T | undefined =>
    (b[k] as T) ?? (q[k] as T) ?? undefined;

  const landingUrl = get<string>("landing") || absoluteUrlFromRequest(req);
  const referrer = (req.get("referer") as string) || get<string>("referrer") || null;
  const ua = req.get("user-agent") || null;
  const ip = clientIp(req);

  return {
    code: cleanCode(get<string>("code")),
    redirect: get<string>("redirect"),
    campaign: cleanShort(get<string>("campaign")),
    medium: cleanShort(get<string>("medium")),
    source: cleanShort(get<string>("source")),
    userId: cleanId(get<string>("userId")),
    landingUrl,
    referrer,
    ua,
    ip,
  };
}

function cleanCode(v?: string | null) {
  if (!v) return null;
  const s = String(v).trim();
  return /^[a-zA-Z0-9_-]{2,64}$/.test(s) ? s : null;
}

function cleanShort(v?: string | null) {
  if (!v) return null;
  const s = String(v).trim();
  return s.length > 128 ? s.slice(0, 128) : s;
}

function cleanId(v?: string | null) {
  if (!v) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function clientIp(req: Request) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) {
    return xf.split(",")[0].trim();
  }
  return (
    (req.headers["cf-connecting-ip"] as string) ||
    (req.headers["x-real-ip"] as string) ||
    (req.socket && (req.socket.remoteAddress as string)) ||
    null
  );
}

function absoluteUrlFromRequest(req: Request) {
  try {
    const proto =
      (req.headers["x-forwarded-proto"] as string) ||
      (String(process.env.NODE_ENV) === "production" ? "https" : "http");
    const host = req.headers.host || "localhost";
    return `${proto}://${host}${req.originalUrl}`;
  } catch {
    return null;
  }
}

function safeRedirect(url?: string | null): string | null {
  if (!url) return null;
  try {
    if (url.startsWith("/")) return url;
    const base = process.env.NEXT_PUBLIC_APP_BASE_URL || process.env.APP_BASE_URL || "";
    if (!base) return null;
    const dest = new URL(url);
    const allow = new URL(base);
    if (dest.host === allow.host && dest.protocol === allow.protocol) return dest.toString();
  } catch {
    /* ignore */
  }
  return null;
}

interface AffiliateRow {
  id: string;
}

async function resolveAffiliateId(code: string | null) {
  if (!code) return null;
  try {
    const probe = await supabase.from("affiliates").select("*", { head: true, count: "exact" }).limit(0);
    if (probe.error) return null;

    const { data, error } = await supabase
      .from("affiliates")
      .select("id")
      .eq("code", code)
      .maybeSingle<AffiliateRow>();

    if (!error && data?.id) return data.id;
  } catch {
    // ignore
  }
  return null;
}

function pickHeaders(
  headers: IncomingHttpHeaders,
  keys: string[],
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  keys.forEach((k) => {
    const v = headers[k];
    if (typeof v !== "undefined") out[k] = v;
  });
  return out;
}
