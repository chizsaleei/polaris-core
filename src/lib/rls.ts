/**
 * Polaris Core - RLS helpers for Supabase
 *
 * Small, framework agnostic utilities to:
 *  - Extract a Supabase user access token from headers or cookies
 *  - Decode JWT claims without verifying signature (for routing only)
 *  - Build Authorization headers for PostgREST or supabase js
 *  - Enforce simple ownership checks in handlers
 *  - Provide a safe fetch wrapper that always carries the user token
 *
 * Server is the source of truth. Never use the service role token for
 * end user requests. These helpers help you avoid that footgun.
 */

// ------------------------------- Types --------------------------------

export interface RequestLike {
  /**
   * Compatible with fetch HeadersInit plus common Node header objects.
   * This shape is shared so API and UI can call `requireAuth` in a consistent way.
   */
  headers?: HeadersInit | Record<string, string | string[]>;
  /** Raw Cookie header if you already have it. */
  cookies?: string;
}

export interface AuthClaims {
  sub?: string; // user id
  role?: string; // 'authenticated' | 'service_role' | custom
  email?: string;
  [k: string]: unknown;
}

export interface AuthContext {
  user_id: string;
  role: string;
  email?: string;
  token: string; // the access token to use for RLS
  claims: AuthClaims;
}

/**
 * Generic row shape for ownership checks that both API and UI can reuse.
 * Any row that includes user_id, owner_id, or profile_id fits this contract.
 */
export type OwnableRow = Record<string, unknown>;

// Internal helper for Supabase auth cookie shape
interface SupabaseAuthCookie {
  currentSession?: {
    access_token?: string | null;
  } | null;
  access_token?: string | null;
  // Allow future fields
  [k: string]: unknown;
}

// ----------------------------- Extraction -----------------------------

/**
 * Try to read a Bearer token from common places:
 * - Authorization: Bearer <jwt>
 * - X-Supabase-Auth: <jwt>
 * - Cookie: sb-access-token=... or supabase-auth-token JSON
 */
export function extractAccessToken(input: RequestLike): string | undefined {
  const h = lowerHeaders(input.headers);
  const auth = h.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) {
    return auth.replace(/^bearer\s+/i, "").trim();
  }

  const xsa = h.get("x-supabase-auth");
  if (xsa) return xsa.trim();

  const cookieHeader = input.cookies || h.get("cookie") || "";
  const map = cookieHeaderToMap(cookieHeader);

  const sb = map.get("sb-access-token");
  if (sb) return sb;

  const authJson = map.get("supabase-auth-token");
  if (authJson) {
    try {
      const parsed: unknown = JSON.parse(decodeURIComponent(authJson));
      const fromCookie = extractTokenFromSupabaseCookie(parsed);
      if (fromCookie) return fromCookie;
    } catch {
      // Ignore malformed Supabase auth cookie and fall through
    }
  }

  return undefined;
}

/** Decode a JWT without verifying signature. Use for routing only. */
export function decodeJwt(token: string): AuthClaims {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const body = base64UrlDecode(parts[1]) || "{}";
    const json = JSON.parse(body) as unknown;
    return (json ?? {}) as AuthClaims;
  } catch {
    return {};
  }
}

/** Build an AuthContext from a request. Throws if no valid user. */
export function requireAuth(req: RequestLike): AuthContext {
  const token = extractAccessToken(req);
  if (!token) throw new Error("Unauthorized: missing access token");

  const claims = decodeJwt(token);
  const user_id = String(claims.sub ?? "").trim();
  const role = String(claims.role ?? "");

  if (!user_id || role === "service_role") {
    throw new Error("Forbidden: invalid user token or service role token");
  }

  const email = typeof claims.email === "string" ? claims.email : undefined;
  return { user_id, role: role || "authenticated", email, token, claims };
}

/** Build headers that carry the user token so RLS applies. */
export function rlsHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Quick owner check for rows that carry a user identifier. */
export function assertOwner(
  row: OwnableRow,
  auth: { user_id: string },
  keys: string[] = ["user_id", "owner_id", "profile_id"],
): void {
  const owner = pickOwnerId(row, keys);
  if (!owner) {
    throw new Error("Forbidden: row has no owner field to verify");
  }
  if (String(owner) !== String(auth.user_id)) {
    throw new Error("Forbidden: not your resource");
  }
}

/**
 * Try to locate an owner id field on a row, given a list of candidate keys.
 * This is exported so both API and UI can reuse the same ownership logic.
 */
export function pickOwnerId(
  row: OwnableRow | null | undefined,
  keys: string[] = ["user_id", "owner_id", "profile_id"],
): string | undefined {
  if (!row) return undefined;
  for (const key of keys) {
    const value = row[key];
    if (value != null) {
      const owner = normalizeOwnerValue(value);
      if (owner) return owner;
    }
  }
  return undefined;
}

/**
 * Merge the correct owner id into a payload, without allowing overwrite to a different user.
 * If the payload already contains a matching owner, keep it.
 * If it contains a different owner, throw.
 */
export function enforceRowOwner<T extends Record<string, unknown>>(
  payload: T,
  auth: { user_id: string },
  key = "user_id",
): T {
  const existing = payload[key];
  if (existing == null) {
    // Add owner field if missing
    return { ...payload, [key]: auth.user_id } as T;
  }
  const owner = normalizeOwnerValue(existing);
  if (!owner) {
    throw new Error("Forbidden: owner must be a string or number");
  }
  if (owner !== String(auth.user_id)) {
    throw new Error("Forbidden: owner mismatch");
  }
  return payload;
}

// ----------------------------- Safe fetch -----------------------------

export interface RlsFetchInit extends RequestInit {
  token: string;
  timeoutMs?: number;
}

/**
 * Safe fetch wrapper that always carries the user token and respects a timeout.
 * The generic type T can be shared with UI consumers that know the response shape.
 */
export async function rlsFetchJson<T = unknown>(
  url: string,
  init: RlsFetchInit,
): Promise<T> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000);

  try {
    const headers = mergeAuthHeader(init.headers, init.token);
    const res = await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
    });

    const data = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      throw new Error(`RLS fetch ${res.status}`);
    }
    return data as T;
  } finally {
    clearTimeout(id);
  }
}

function mergeAuthHeader(h: HeadersInit | undefined, token: string): HeadersInit {
  const out: Record<string, string> = {};

  if (h instanceof Headers) {
    h.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(h)) {
    // Tuple array form: [ [key, value], ... ]
    for (const [key, value] of h) {
      out[String(key)] = String(value);
    }
  } else if (h && typeof h === "object") {
    // Plain object form
    for (const [key, value] of Object.entries(h)) {
      out[key] = String(value);
    }
  }

  out.Authorization = `Bearer ${token}`;
  return out;
}

// ------------------------------- Utils --------------------------------

/**
 * Normalize headers to a lowercase map, independent of environment.
 */
function lowerHeaders(h?: RequestLike["headers"]): Map<string, string> {
  const map = new Map<string, string>();
  if (!h) return map;

  if (h instanceof Headers) {
    h.forEach((value, key) => {
      map.set(key.toLowerCase(), value);
    });
    return map;
  }

  if (Array.isArray(h)) {
    for (const [key, value] of h) {
      map.set(String(key).toLowerCase(), String(value));
    }
    return map;
  }

  if (typeof h === "object") {
    const obj = h as Record<string, string | string[]>;
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) {
        map.set(key.toLowerCase(), String(value[0]));
      } else {
        map.set(key.toLowerCase(), value);
      }
    }
  }

  return map;
}

function cookieHeaderToMap(cookieHeader: string): Map<string, string> {
  const m = new Map<string, string>();
  if (!cookieHeader) return m;
  const parts = cookieHeader.split(/;\s*/);
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      const k = part.slice(0, idx);
      const v = part.slice(idx + 1);
      m.set(k, v);
    }
  }
  return m;
}

function normalizeOwnerValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return undefined;
}

function base64UrlDecode(part: string): string {
  try {
    const s = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
    return Buffer.from(s + pad, "base64").toString("utf8");
  } catch {
    // On malformed base64, fall back to empty string
    return "";
  }
}

/**
 * Safely extract an access token from Supabase `supabase-auth-token` cookie JSON.
 */
function extractTokenFromSupabaseCookie(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as SupabaseAuthCookie;

  const currentSession = obj.currentSession;
  if (currentSession && typeof currentSession === "object") {
    const token = currentSession.access_token;
    if (typeof token === "string" && token.trim()) {
      return token.trim();
    }
  }

  const direct = obj.access_token;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  return undefined;
}

// ------------------------------- Examples -----------------------------
//
// const auth = requireAuth({ headers: req.headers, cookies: req.headers.cookie });
// const payload = enforceRowOwner(reqBody, auth);
// const { data, error } = await supabase.from("sessions").insert(payload).select();
// assertOwner(data[0], auth);
