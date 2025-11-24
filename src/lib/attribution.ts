/**
 * Polaris Core - attribution helpers
 * - Parse UTM and click identifiers from a request
 * - Infer marketing channel and affiliate codes
 * - Produce first-touch and last-touch cookies with HMAC signatures
 * - Return normalized payloads safe for storage and analytics
 *
 * This module has no framework dependencies. Pass a minimal Request-like object.
 */

import { createHmac, randomUUID, createHash } from "node:crypto";
import type {
  AttributionChannel,
  AttributionCore,
  AttributionCookies,
  AttributionUtm as Utm,
  AttributionClickIds as ClickIds,
} from "../types";

// ----------------------------- Types ---------------------------------

export type Channel = AttributionChannel;

export interface RequestLike {
  url?: string;
  headers?: Headers | Record<string, string | string[]>;
  ip?: string | null;
}

export interface ExtractResult {
  attribution: AttributionCore;
  cookies: AttributionCookies;
}

// ----------------------------- Config --------------------------------

const APP_BASE = process.env.NEXT_PUBLIC_APP_BASE_URL || process.env.APP_BASE_URL || "";
const SITE_HOST = safeHost(APP_BASE);
const ATTRIB_SECRET = process.env.ATTRIBUTION_SIGNING_SECRET || "dev-secret-change";
const IP_SALT = process.env.ATTRIBUTION_IP_SALT || "dev-ip-salt";

export const FIRST_TOUCH_COOKIE = "pc_attrib_ft" as const;
export const LAST_TOUCH_COOKIE = "pc_attrib_lt" as const;

// Windows
const FT_WINDOW_DAYS = 90; // first-touch sticks for 90 days
const LT_WINDOW_DAYS = 7;  // last-touch refreshes within 7 days

// ----------------------------- Main API ------------------------------

/**
 * Extract attribution data and cookie instructions from a request.
 */
export function extractAttribution(req: RequestLike): ExtractResult {
  const nowIso = new Date().toISOString();
  const h = lowerHeaders(req.headers);
  const url = safeUrl(req.url);
  const referrer = h.get("referer") || h.get("referrer") || undefined;
  const userAgent = h.get("user-agent") || undefined;
  const country =
    h.get("cf-ipcountry") || h.get("x-vercel-ip-country") || h.get("x-country") || undefined;

  const query = parseQuery(url?.search || "");
  const utm = pickUtm(query);
  const click = pickClickIds(query);
  const affiliate_code = pickAffiliateCode(query);

  const rawIp = req.ip ?? h.get("x-real-ip") ?? firstIp(h.get("x-forwarded-for"));
  const ip = typeof rawIp === "string" && rawIp.trim().length > 0 ? rawIp : undefined;
  const ip_hash = ip ? hashIp(ip) : undefined;

  const landing_url = url?.toString();
  const site_domain = SITE_HOST || (url ? url.host : undefined);

  const channel = inferChannel({ utm, click, referrer, affiliate_code });

  const core: AttributionCore = {
    ts: nowIso,
    request_id: randomUUID(),
    landing_url,
    referrer,
    user_agent: userAgent,
    country,
    ip_hash,
    utm,
    click,
    affiliate_code,
    channel,
    site_domain,
  };

  const cookies = buildAttributionCookies(core, { existing: cookieHeaderToMap(h.get("cookie")) });

  return { attribution: core, cookies };
}

// -------------------------- Channel logic ----------------------------

function inferChannel(input: {
  utm: Utm;
  click: ClickIds;
  referrer?: string;
  affiliate_code?: string;
}): Channel {
  const { utm, click, referrer, affiliate_code } = input;
  const m = (utm.medium || "").toLowerCase();
  const s = (utm.source || "").toLowerCase();

  if (affiliate_code) return "affiliate";

  if (click.gclid || click.msclkid) return "paid_search";
  if (m === "cpc" || m === "ppc" || m === "paid" || m === "sem") return "paid_search";

  if (m === "paid_social" || m === "social_paid") return "paid_social";
  if (m === "social") return "social";
  if (m === "email" || s === "email") return "email";

  const host = safeHost(referrer);
  if (host) {
    if (isSearchDomain(host) && !utm.source && !utm.medium) return "organic_search";
    if (!isOwnDomain(host)) return "referral";
  }

  if (!referrer && !utm.source && !utm.medium) return "direct";
  return "unknown";
}

function isOwnDomain(host?: string | null): boolean {
  if (!host || !SITE_HOST) return false;
  return stripWww(host) === stripWww(SITE_HOST);
}

function isSearchDomain(host: string): boolean {
  const h = stripWww(host);
  return (
    h.endsWith("google.com") ||
    h.endsWith("bing.com") ||
    h.endsWith("yahoo.com") ||
    h.endsWith("duckduckgo.com") ||
    h.endsWith("yandex.ru") ||
    h.endsWith("baidu.com") ||
    h.endsWith("ecosia.org")
  );
}

// ------------------------- Cookie utilities --------------------------

interface CookieBuildOpts {
  existing?: Map<string, string>;
}

export function buildAttributionCookies(attrib: AttributionCore, opts?: CookieBuildOpts): AttributionCookies {
  const existing = opts?.existing || new Map<string, string>();

  const ftRaw = existing.get(FIRST_TOUCH_COOKIE);
  const ltRaw = existing.get(LAST_TOUCH_COOKIE);
  const ft = ftRaw ? verifyCookie(ftRaw) : null;
  const lt = ltRaw ? verifyCookie(ltRaw) : null;

  const ftExpired = !ft || isOlderThanDays(ft.ts, FT_WINDOW_DAYS);
  const ltExpired = !lt || isOlderThanDays(lt.ts, LT_WINDOW_DAYS);

  const first = ftExpired ? cookieValue({ ...minimalCookiePayload(attrib), kind: "ft" }) : undefined;
  const last = cookieValue({ ...minimalCookiePayload(attrib), kind: "lt" });

  const cookies: AttributionCookies = {};
  if (first) cookies.firstTouch = makeCookie(FIRST_TOUCH_COOKIE, first, 60 * 60 * 24 * FT_WINDOW_DAYS);
  if (!lt || ltExpired || shouldRefreshLastTouch(lt, attrib)) {
    cookies.lastTouch = makeCookie(LAST_TOUCH_COOKIE, last, 60 * 60 * 24 * LT_WINDOW_DAYS);
  }
  return cookies;
}

type MiniAttrib = {
  ts: string;
  channel: Channel;
  utm?: Utm;
  click?: ClickIds;
  affiliate_code?: string;
  referrer?: string;
  landing_url?: string;
  kind: "ft" | "lt";
};

function minimalCookiePayload(a: AttributionCore): Omit<MiniAttrib, "kind"> {
  return {
    ts: a.ts,
    channel: a.channel,
    utm: a.utm,
    click: a.click,
    affiliate_code: a.affiliate_code,
    referrer: a.referrer,
    landing_url: a.landing_url,
  };
}

function cookieValue(payload: MiniAttrib): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = hmacSha256(ATTRIB_SECRET, b64);
  return `${b64}.${sig}`;
}

export function verifyCookie(value: string): MiniAttrib | null {
  const [b64, sig] = value.split(".");
  if (!b64 || !sig) return null;
  const good = hmacSha256(ATTRIB_SECRET, b64);
  if (!timingSafeEq(sig, good)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    // very light validation
    if (!parsed || typeof (parsed as { ts?: unknown }).ts !== "string") return null;
    return parsed as MiniAttrib;
  } catch {
    return null;
  }
}

function makeCookie(name: string, value: string, maxAgeSec: number): string {
  const parts = [
    `${name}=${value}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  // Secure for non-localhost
  if (SITE_HOST && SITE_HOST !== "localhost") parts.push("Secure");
  parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`);
  return parts.join("; ");
}

function shouldRefreshLastTouch(prev: MiniAttrib, current: AttributionCore): boolean {
  // Refresh if channel meaningfully changed or new affiliate/paid source
  const paidNow = current.channel === "paid_search" || current.channel === "paid_social";
  const paidPrev = prev.channel === "paid_search" || prev.channel === "paid_social";
  if (paidNow && !paidPrev) return true;
  if (!!current.affiliate_code && current.affiliate_code !== prev.affiliate_code) return true;
  // If UTM changed campaign, refresh
  if (current.utm.campaign && current.utm.campaign !== (prev.utm?.campaign || "")) return true;
  return false;
}

// ----------------------- Builders for storage -------------------------

export interface AffiliateReferralUpsert {
  code?: string;
  channel: Channel;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  gclid?: string;
  msclkid?: string;
  fbclid?: string;
  twclid?: string;
  ttclid?: string;
  clid?: string;
  referrer?: string;
  landing_url?: string;
  country?: string;
  user_agent?: string;
  first_touch_at?: string; // ISO
  last_touch_at?: string;  // ISO
}

/**
 * Build an affiliate-referral row payload from attribution plus optional cookie history.
 */
export function buildAffiliateReferralUpsert(attrib: AttributionCore, cookies?: {
  ft?: MiniAttrib | null;
  lt?: MiniAttrib | null;
}): AffiliateReferralUpsert {
  const ft = cookies?.ft ?? null;
  const first_touch_at = ft?.ts || attrib.ts;
  const last_touch_at = attrib.ts;
  return {
    code: sanitizeAffiliate(attrib.affiliate_code),
    channel: attrib.channel,
    utm_source: attrib.utm.source,
    utm_medium: attrib.utm.medium,
    utm_campaign: attrib.utm.campaign,
    utm_term: attrib.utm.term,
    utm_content: attrib.utm.content,
    gclid: attrib.click.gclid,
    msclkid: attrib.click.msclkid,
    fbclid: attrib.click.fbclid,
    twclid: attrib.click.twclid,
    ttclid: attrib.click.ttclid,
    clid: attrib.click.clid,
    referrer: attrib.referrer,
    landing_url: attrib.landing_url,
    country: attrib.country,
    user_agent: attrib.user_agent,
    first_touch_at,
    last_touch_at,
  };
}

export interface AnalyticsEvent {
  name: string;
  ts: string; // ISO
  props: Record<string, unknown>;
}

export function toAnalyticsEvent(attrib: AttributionCore, name: string, extra?: Record<string, unknown>): AnalyticsEvent {
  const base = {
    channel: attrib.channel,
    utm_source: attrib.utm.source,
    utm_medium: attrib.utm.medium,
    utm_campaign: attrib.utm.campaign,
    utm_term: attrib.utm.term,
    utm_content: attrib.utm.content,
    gclid: attrib.click.gclid,
    msclkid: attrib.click.msclkid,
    fbclid: attrib.click.fbclid,
    twclid: attrib.click.twclid,
    ttclid: attrib.click.ttclid,
    clid: attrib.click.clid,
    affiliate_code: sanitizeAffiliate(attrib.affiliate_code),
    landing_url: attrib.landing_url,
    referrer: attrib.referrer,
    country: attrib.country,
    site_domain: attrib.site_domain,
  };
  return { name, ts: attrib.ts, props: { ...base, ...(extra || {}) } };
}

// ----------------------------- Helpers -------------------------------

function isHeadersInstance(value: RequestLike["headers"]): value is Headers {
  return typeof Headers !== "undefined" && value instanceof Headers;
}

function lowerHeaders(h?: RequestLike["headers"]): Map<string, string> {
  const map = new Map<string, string>();
  if (!h) return map;

  // Handle Headers-like objects in a DOM or Node fetch environment
  if (isHeadersInstance(h)) {
    h.forEach((value, key) => {
      map.set(String(key).toLowerCase(), value);
    });
    return map;
  }

  // Fallback: treat as plain record
  const obj: Record<string, string | string[]> = h;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    map.set(key.toLowerCase(), Array.isArray(v) ? v[0] : String(v));
  }
  return map;
}

function parseQuery(search: string): URLSearchParams {
  try {
    return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    return new URLSearchParams();
  }
}

function pickUtm(q: URLSearchParams): Utm {
  const u: Utm = {};
  const get = (k: string) => val(q.get(k));
  u.source = get("utm_source");
  u.medium = get("utm_medium");
  u.campaign = get("utm_campaign");
  u.term = get("utm_term");
  u.content = get("utm_content");
  return u;
}

function pickClickIds(q: URLSearchParams): ClickIds {
  return {
    gclid: val(q.get("gclid")),
    msclkid: val(q.get("msclkid")),
    fbclid: val(q.get("fbclid")),
    twclid: val(q.get("twclid")),
    ttclid: val(q.get("ttclid")),
    clid: val(q.get("clid") || q.get("click_id")),
  };
}

function pickAffiliateCode(q: URLSearchParams): string | undefined {
  const raw = q.get("aff") || q.get("affiliate") || q.get("ref") || q.get("ref_code") || q.get("r");
  return sanitizeAffiliate(val(raw));
}

function sanitizeAffiliate(v?: string): string | undefined {
  if (!v) return undefined;
  const cleaned = v.trim();
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(cleaned)) return undefined;
  return cleaned;
}

function val(s: string | null | undefined): string | undefined {
  const v = s == null ? undefined : String(s).trim();
  return v ? v : undefined;
}

function safeUrl(s?: string): URL | undefined {
  try { return s ? new URL(s) : undefined; } catch { return undefined; }
}

function safeHost(s?: string | null): string | undefined {
  try { return s ? new URL(s).host : undefined; } catch { return undefined; }
}

function stripWww(host: string): string { return host.replace(/^www\./i, ""); }

function firstIp(xff?: string): string | undefined {
  if (!xff) return undefined;
  const first = xff.split(",")[0]?.trim();
  return first || undefined;
}

function isOlderThanDays(iso: string, days: number): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  const ms = days * 24 * 60 * 60 * 1000;
  return Date.now() - t > ms;
}

function hmacSha256(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return createHash("sha256").update(ab).digest("hex") === createHash("sha256").update(bb).digest("hex");
}

function hashIp(ip: string): string {
  return createHmac("sha256", IP_SALT).update(ip).digest("base64url");
}

function cookieHeaderToMap(cookieHeader?: string): Map<string, string> {
  const m = new Map<string, string>();
  if (!cookieHeader) return m;
  const parts = cookieHeader.split(/;\s*/);
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx > 0) {
      const k = p.slice(0, idx);
      const v = p.slice(idx + 1);
      m.set(k, v);
    }
  }
  return m;
}

// ----------------------------- End -----------------------------------
