// polaris-core/src/server/routes/auth/guard.ts
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { createClient as createSb } from "@supabase/supabase-js";
import type { AuthInfo } from "../../middleware/auth";
import type { Tier } from "../../../types";

/**
 * AuthGuard
 * - Verifies the Supabase access token (Authorization: Bearer <jwt>)
 * - Falls back to x-user-id header when token is not present
 * - Optionally enforces admin-only access
 */

type Database = any;

export type AuthGuardOptions = {
  optional?: boolean; // allow unauthenticated requests
  adminOnly?: boolean; // require admin privileges
};

type SupabaseUser = { id: string; email?: string | null };
type GuardUser = AuthInfo & { id?: string | null; accessToken?: string | null };
type GuardRequest = Request<ParamsDictionary> & { user?: GuardUser };

export function authGuard(opts: AuthGuardOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void handleAuthGuard(req as GuardRequest, res, next, opts);
  };
}

const handleAuthGuard = async (
  req: GuardRequest,
  res: Response,
  next: NextFunction,
  opts: AuthGuardOptions,
): Promise<void> => {
  try {
    const token = getAccessToken(req);
    let user: SupabaseUser | undefined;

    if (token) {
      const sb = anonClient();
      const { data, error } = await sb.auth.getUser(token);
      if (error || !data?.user) {
        if (opts.optional) {
          next();
          return;
        }
        res.status(401).json({ error: "invalid_token" });
        return;
      }
      user = { id: data.user.id, email: data.user.email ?? null };
      req.user = {
        userId: user.id,
        email: user.email ?? null,
        tier: "free" as Tier,
        id: user.id,
        accessToken: token,
      };
    } else {
      const uid = headerId(req);
      if (!uid) {
        if (opts.optional) {
          next();
          return;
        }
        res.status(401).json({ error: "missing_auth" });
        return;
      }
      req.user = { userId: uid, tier: "free" as Tier, id: uid };
      user = { id: uid };
    }

    if (opts.adminOnly) {
      const ok = await isAdmin(user.id);
      if (!ok) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
    }

    next();
  } catch {
    res.status(500).json({ error: "internal_error" });
  }
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function anonClient() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "";
  const anon =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    "";
  if (!url) throw new Error("Supabase URL is missing. Set NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL.");
  if (!anon) throw new Error("Supabase anon key is missing. Set NEXT_PUBLIC_SUPABASE_ANON_KEY or SUPABASE_ANON_KEY.");
  return createSb<Database>(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { "X-Client-Info": "polaris-core-auth-guard" } },
  });
}

function headerId(req: Request): string | null {
  const val = req.header("x-user-id") || req.header("x-supabase-user-id");
  return val ? String(val).trim() : null;
}

function getAccessToken(req: Request): string | null {
  // Authorization: Bearer <token>
  const auth = req.header("authorization") || req.header("Authorization");
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }

  // Optional cookie fallback
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/(?:^|;\s*)sb-access-token=([^;]+)/);
  if (m) return decodeURIComponent(m[1]);

  // Custom header
  const h = req.header("x-access-token");
  if (h) return String(h).trim();

  return null;
}

/**
 * Admin check
 * - First tries profiles.is_admin boolean
 * - Falls back to is_admin(user_id) RPC if present
 */
async function isAdmin(userId: string): Promise<boolean> {
  try {
    const sb = anonClient();

    // 1) profiles.is_admin boolean
    const { data: prof, error: profErr } = await sb
      .from("profiles")
      .select("is_admin")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle<{ is_admin: boolean | null }>();

    if (!profErr && prof) {
      const record = toRecord(prof);
      if (record && typeof record.is_admin === "boolean") {
        return record.is_admin;
      }
    }

    // 2) RPC is_admin(user_id)
    const rpcResult = await sb.rpc("is_admin", { p_user_id: userId });
    if (!rpcResult.error && typeof rpcResult.data === "boolean") {
      return rpcResult.data;
    }

    return false;
  } catch {
    return false;
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export default authGuard;
