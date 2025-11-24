/**
 * Polaris Core — Payments reconciliation
 *
 * Nightly job that compares provider-normalized ledger events with
 * current user entitlements, then proposes and applies fixes.
 *
 * This module is framework-agnostic and database-agnostic. Implement the
 * `ReconcileStore` interface for your data layer (e.g., Supabase) and pass it
 * into `runReconciliation`. The algorithm is intentionally conservative:
 *  - Trusts the latest subscription or payment success event per user
 *  - Downgrades on explicit cancellation or full refund (if newer than last success)
 *  - Never upgrades without a plan_key
 *  - Writes a correction note to the ledger for auditing
 */

import { log, safeError } from "../../lib/logger";
import type { PlanKey } from "../../lib/constants";
import { planMeta, type NormalizedEvent } from "./index";

// ------------------------------- Types --------------------------------

export type Tier = "free" | "pro" | "vip";

export interface Entitlement {
  user_id: string;
  tier: Tier;
  plan_key: PlanKey | null;
  status: "active" | "canceled" | "none"; // "none" means free/no paid entitlement
  expires_at?: string | null;
  updated_at?: string; // ISO
}

export interface LedgerCorrection {
  correction_id: string; // idempotency key for this correction
  user_id: string;
  reason: string;
  before?: Partial<Entitlement> | null;
  after?: Partial<Entitlement> | null;
  created_at: string; // ISO
  related_event_id?: string | null; // provider event id that triggered correction
}

export interface ReconciliationOptions {
  /** consider events since this ISO date (defaults to 120 days ago) */
  sinceIso?: string;
  /** dryRun means compute actions but do not persist */
  dryRun?: boolean;
  /** limit processed users for batch testing */
  limitUsers?: number;
}

export interface ReconcileStore {
  /**
   * Return normalized provider events since a given ISO date.
   * Only events with a resolvable user should be returned (user_hint populated).
   */
  listLedgerSince(sinceIso: string): Promise<NormalizedEvent[]>;

  /** Batch load current entitlements by user id. Missing users may be omitted. */
  getEntitlements(userIds: string[]): Promise<Record<string, Entitlement | null>>;

  /** Apply a grant or change to an entitlement. Must be idempotent. */
  setEntitlement(userId: string, patch: Partial<Entitlement> & { tier: Tier; plan_key: PlanKey | null; status: Entitlement["status"] }): Promise<void>;

  /** Mark a user as free (no paid entitlement). Must be idempotent. */
  setFree(userId: string): Promise<void>;

  /** Append a correction audit row to payments ledger. Must be idempotent. */
  appendCorrection(note: LedgerCorrection): Promise<void>;
}

export type ReconcileAction =
  | { kind: "grant"; user_id: string; plan_key: PlanKey; tier: Exclude<Tier, "free">; reason: string; event_id?: string }
  | { kind: "downgrade"; user_id: string; reason: string; event_id?: string }
  | { kind: "fix_plan_key"; user_id: string; plan_key: PlanKey; tier: Exclude<Tier, "free">; reason: string; event_id?: string }
  | { kind: "noop"; user_id: string; reason: string };

export interface ReconcileSummary {
  sinceIso: string;
  users_seen: number;
  actions: ReconcileAction[];
  applied: number;
}

// ------------------------------- Driver -------------------------------

export async function runReconciliation(store: ReconcileStore, opts: ReconciliationOptions = {}): Promise<ReconcileSummary> {
  const sinceIso = opts.sinceIso || isoDaysAgo(120);
  log.info("reconciliation start", { sinceIso, dryRun: !!opts.dryRun });

  const events = await store.listLedgerSince(sinceIso);
  const byUser = groupByUser(events.filter((e) => !!e.user_hint));
  const userIds = Object.keys(byUser).slice(0, opts.limitUsers ?? Number.MAX_SAFE_INTEGER);

  const entMap = await store.getEntitlements(userIds);
  const actions: ReconcileAction[] = [];

  for (const userId of userIds) {
    const evs = sortByCreated(byUser[userId]);
    const expected = deriveExpectedEntitlement(evs);
    const current = entMap[userId] || null;
    const diff = diffState(userId, current, expected);
    if (diff) actions.push(diff);
  }

  let applied = 0;
  if (!opts.dryRun) applied = await applyActions(store, actions);

  log.info("reconciliation done", { users: userIds.length, actions: actions.length, applied });
  return { sinceIso, users_seen: userIds.length, actions, applied };
}

// ----------------------------- Derivation -----------------------------

function deriveExpectedEntitlement(events: NormalizedEvent[]): { status: Entitlement["status"]; plan_key: PlanKey | null; tier: Tier } {
  // Walk from newest to oldest to find decisive state
  const newest = [...events].sort((a, b) => cmpIso(b.created_at, a.created_at));

  // 1) Cancellation beats everything if it is the newest decisive event
  const cancel = newest.find((e) => e.type === "subscription_canceled");
  if (cancel) return { status: "canceled", plan_key: null, tier: "free" };

  // 2) A recent refund with no newer success implies downgrade
  const refund = newest.find((e) => e.type === "payment_refunded");
  const successAfterRefund = newest.find((e) => e.type === "payment_succeeded" && cmpIso(e.created_at, refund?.created_at || "1970") > 0);
  if (refund && !successAfterRefund) return { status: "none", plan_key: null, tier: "free" };

  // 3) Subscription events set active state if they carry a plan_key
  const sub = newest.find((e) => e.type === "subscription_updated" || e.type === "subscription_created");
  if (sub && sub.plan_key) {
    const t = metaToTier(sub.plan_key);
    return { status: "active", plan_key: sub.plan_key, tier: t };
  }

  // 4) A one-off "payment_succeeded" with a plan_key upgrades to active
  const pay = newest.find((e) => e.type === "payment_succeeded" && !!e.plan_key);
  if (pay && pay.plan_key) {
    const t = metaToTier(pay.plan_key);
    return { status: "active", plan_key: pay.plan_key, tier: t };
  }

  // Otherwise we make no change
  return { status: "none", plan_key: null, tier: "free" };
}

function metaToTier(plan: PlanKey): Exclude<Tier, "free"> {
  const { tier } = planMeta(plan);
  return tier;
}

// ------------------------------- Diffing ------------------------------

function diffState(user_id: string, current: Entitlement | null, expected: { status: Entitlement["status"]; plan_key: PlanKey | null; tier: Tier }): ReconcileAction | null {
  // Current is empty and expected is none => noop
  if (!current && (expected.status === "none" || expected.status === "canceled")) {
    return { kind: "noop", user_id, reason: "no entitlement and none expected" };
  }

  // If expected is free/none and current shows paid -> downgrade
  if ((expected.status === "none" || expected.status === "canceled") && current && current.tier !== "free") {
    return { kind: "downgrade", user_id, reason: `expected ${expected.status}, found ${current.tier}` };
  }

  // If expected is active with a plan
  if (expected.status === "active" && expected.plan_key) {
    if (!current || current.tier === "free") {
      return { kind: "grant", user_id, plan_key: expected.plan_key, tier: expected.tier as Exclude<Tier, "free">, reason: "grant from latest provider event" };
    }
    // Already paid but different plan_key -> fix plan
    if (current.plan_key !== expected.plan_key) {
      return { kind: "fix_plan_key", user_id, plan_key: expected.plan_key, tier: expected.tier as Exclude<Tier, "free">, reason: `align plan_key ${current.plan_key} -> ${expected.plan_key}` };
    }
  }

  return null;
}

// ------------------------------- Apply --------------------------------

async function applyActions(store: ReconcileStore, actions: ReconcileAction[]): Promise<number> {
  let applied = 0;
  for (const a of actions) {
    try {
      if (a.kind === "noop") continue;

      if (a.kind === "downgrade") {
        await store.setFree(a.user_id);
        await store.appendCorrection({
          correction_id: buildCorrectionId(a),
          user_id: a.user_id,
          reason: a.reason,
          before: null,
          after: { tier: "free", plan_key: null, status: "none" },
          created_at: new Date().toISOString(),
          related_event_id: a.event_id ?? null,
        });
      } else if (a.kind === "grant" || a.kind === "fix_plan_key") {
        await store.setEntitlement(a.user_id, {
          tier: a.tier,
          plan_key: a.plan_key,
          status: "active",
        });
        await store.appendCorrection({
          correction_id: buildCorrectionId(a),
          user_id: a.user_id,
          reason: a.reason,
          before: null,
          after: { tier: a.tier, plan_key: a.plan_key, status: "active" },
          created_at: new Date().toISOString(),
          related_event_id: a.event_id ?? null,
        });
      }

      applied++;
    } catch (err) {
      log.error("reconciliation apply failed", { action: a, err: safeError(err) });
    }
  }
  return applied;
}

function buildCorrectionId(a: ReconcileAction): string {
  const base = `${a.kind}:${a.user_id}:${"plan_key" in a ? a.plan_key : "-"}`;
  return hashBase64Url(base);
}

// ------------------------------- Utilities ----------------------------

function groupByUser(evs: NormalizedEvent[]): Record<string, NormalizedEvent[]> {
  const out: Record<string, NormalizedEvent[]> = {};
  for (const e of evs) {
    const u = (e.user_hint || "").trim();
    if (!u) continue;
    (out[u] = out[u] || []).push(e);
  }
  return out;
}

function sortByCreated(evs: NormalizedEvent[]): NormalizedEvent[] {
  return [...evs].sort((a, b) => cmpIso(a.created_at, b.created_at));
}

function cmpIso(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return ta === tb ? 0 : ta < tb ? -1 : 1;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Math.max(0, Math.floor(days)));
  return d.toISOString();
}

import { createHash } from "node:crypto";

function hashBase64Url(s: string): string {
  const buf = Buffer.from(s, "utf8");
  const digest = createHash("sha1").update(buf).digest("base64");
  return digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ------------------------------- Notes --------------------------------
// - This job does not attempt to compute future renewal dates. The source of
//   truth for renewal windows remains your provider and the webhook stream.
// - If you store multiple entitlements per user (e.g., add-on tools), extend
//   the Entitlement shape and diff logic accordingly.
// - If you operate in multi-currency, ensure your ledger includes currency and
//   amount for downstream finance reports. Reconciliation here focuses on access.
