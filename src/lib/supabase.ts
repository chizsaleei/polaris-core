// src/lib/supabase.ts
/**
 * Polaris Core — Supabase client helpers
 *
 * Provides:
 *  - createClient(): cached service-role admin client for server tasks
 *  - userClient(accessToken): per-request RLS client bound to a JWT
 *  - rlsHeader(accessToken): header helper for PostgREST or fetch
 *
 * Uses src/config/env.ts for consistent config. Never call on the client.
 */

import { createClient as createSb, type SupabaseClient } from "@supabase/supabase-js";
import { publicEnv, serverEnv, isDev } from "../config/env";
import { log } from "./logger";

// If you have generated types, re-export them here.
// import type { Database } from "../types/database";
export type Database = any;

// ------------------------------ Cached admin client ------------------------------

let _admin: SupabaseClient<Database> | null = null;

/**
 * Cached service-role client for server code.
 * Default export used by the server entry and route handlers.
 */
export function createClient(): SupabaseClient<Database> {
  if (_admin) return _admin;

  // URL and anon key are "public", service role is server only
  const pub = publicEnv();
  const srv = serverEnv();

  _admin = createSb<Database>(pub.SUPABASE_URL, srv.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: {
      headers: {
        "X-Client-Info": "polaris-core-admin",
      },
    },
    db: { schema: "public" },
  });

  if (isDev) log.info("supabase admin client initialized", { url: maskUrl(pub.SUPABASE_URL) });
  return _admin;
}

/** Alias for callers that prefer explicit naming. */
export const admin = createClient;

// ------------------------------ Per-request RLS client ------------------------------

/**
 * Create a Supabase client that carries a user's access token so RLS applies.
 * Not cached because tokens differ per request.
 */
export function userClient(accessToken: string): SupabaseClient<Database> {
  if (!accessToken || typeof accessToken !== "string") {
    throw new Error("userClient requires a valid access token");
  }

  const pub = publicEnv();
  return createSb<Database>(pub.SUPABASE_URL, pub.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Client-Info": "polaris-core-rls",
      },
    },
    db: { schema: "public" },
  });
}

/** Build Authorization header for PostgREST or fetch calls outside supabase-js. */
export function rlsHeader(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` } as const;
}

// ------------------------------ Utilities ------------------------------

function maskUrl(url: string) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}
