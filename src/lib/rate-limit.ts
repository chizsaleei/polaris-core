/**
 * Polaris Core — simple, dependency-free rate limiting utilities
 *
 * Strategies:
 *  - Fixed window counter with optional block TTL after exceed
 *  - Works with in-memory store (single process) or Upstash-like REST KV
 *
 * This module avoids framework coupling. Call it from route handlers.
 */

import { log } from "./logger";

// ------------------------------- Types --------------------------------

export interface RateLimitRule {
  /** window in milliseconds for the counter */
  windowMs: number;
  /** max number of tokens allowed per window */
  max: number;
  /** optional block duration after exceeding, in ms */
  blockDurationMs?: number;
  /** namespace prefix for keys */
  prefix?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  /** remaining tokens in this window (0 if exceeded) */
  remaining: number;
  /** epoch ms when the current window resets */
  resetAt: number;
  /** if blocked, epoch ms when blocking ends */
  blockedUntil?: number;
  /** reason string for logs and headers */
  reason?: string;
}

export interface Store {
  /** atomically increase key by n and set TTL when new */
  incr(key: string, ttlSec: number, n?: number): Promise<number>;
  /** set a string value with TTL (overwrite) */
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** get a string value */
  get(key: string): Promise<string | null>;
}

// ------------------------------ Helpers -------------------------------

function now() { return Date.now(); }
function windowKey(prefix: string | undefined, id: string, windowMs: number, t: number) {
  const bucket = Math.floor(t / windowMs);
  return `${prefix || "rl"}:${id}:${windowMs}:${bucket}`;
}

function blockKey(prefix: string | undefined, id: string) {
  return `${prefix || "rl"}:block:${id}`;
}

export function retryAfterSeconds(res: RateLimitResult): number | undefined {
  if (!res.allowed) {
    const ms = res.blockedUntil ? Math.max(0, res.blockedUntil - now()) : Math.max(0, res.resetAt - now());
    return Math.ceil(ms / 1000);
  }
  return undefined;
}

// --------------------------- Memory store -----------------------------

type Entry = { value: number; exp: number } | { value: string; exp: number };

function isNumberEntry(entry: Entry | undefined): entry is { value: number; exp: number } {
  return typeof entry?.value === "number";
}

export class MemoryStore implements Store {
  private map = new Map<string, Entry>();
  private sweepEveryMs = 30_000;
  private timer?: NodeJS.Timeout;

  constructor() {
    this.timer = setInterval(() => this.sweep(), this.sweepEveryMs).unref();
  }

  private sweep() {
    const t = now();
    for (const [k, e] of this.map) if (e.exp <= t) this.map.delete(k);
  }

  incr(key: string, ttlSec: number, n = 1): Promise<number> {
    const t = now();
    const exp = t + ttlSec * 1000;
    const entry = this.map.get(key);
    const val = !entry || entry.exp <= t || !isNumberEntry(entry) ? n : entry.value + n;
    this.map.set(key, { value: val, exp });
    return Promise.resolve(val);
  }

  set(key: string, value: string, ttlSec: number): Promise<void> {
    const exp = now() + ttlSec * 1000;
    this.map.set(key, { value, exp });
    return Promise.resolve();
  }

  get(key: string): Promise<string | null> {
    const entry = this.map.get(key);
    if (!entry) return Promise.resolve(null);
    if (entry.exp <= now()) {
      this.map.delete(key);
      return Promise.resolve(null);
    }
    const value = entry.value;
    return Promise.resolve(typeof value === "string" ? value : String(value));
  }
}

// ---------------------------- Upstash KV ------------------------------

/** Minimal Upstash-like REST KV client using fetch and a single URL base. */
export class UpstashKVStore implements Store {
  private base: string;
  private token: string;

  constructor(baseUrl = process.env.POLARIS_REST_API_KV_REST_API_URL, token = process.env.POLARIS_REST_API_KV_REST_API_TOKEN) {
    if (!baseUrl || !token) throw new Error("UpstashKVStore requires REST url and token envs");
    this.base = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  private async api<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`KV REST ${res.status}`);
    return (await res.json()) as T;
  }

  async incr(key: string, ttlSec: number, n = 1): Promise<number> {
    // Upstash supports INCRBY and EXPIRE. Do two calls, tolerate races.
    const inc = await this.api<{ result: number }>(`/incrby/${encodeURIComponent(key)}/${n}`);
    // set expiry every time to keep window alive
    await this.api(`/pexpire/${encodeURIComponent(key)}/${ttlSec * 1000}`);
    return inc.result;
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    await this.api(`/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}?px=${ttlSec * 1000}`);
  }

  async get(key: string): Promise<string | null> {
    const g = await this.api<{ result: string | null }>(`/get/${encodeURIComponent(key)}`);
    return g.result;
  }
}

// --------------------------- Core limiter -----------------------------

export class RateLimiter {
  private store: Store;
  private rule: RateLimitRule;

  constructor(rule: RateLimitRule, store?: Store) {
    this.rule = rule;
    this.store = store || new MemoryStore();
  }

  /** Consume 1 token (or n) for an identifier. */
  async consume(id: string, n = 1): Promise<RateLimitResult> {
    const t = now();
    const key = windowKey(this.rule.prefix, id, this.rule.windowMs, t);
    const ttlSec = Math.ceil(this.rule.windowMs / 1000);
    const blockK = blockKey(this.rule.prefix, id);

    // Check block first
    const blocked = await this.store.get(blockK);
    if (blocked) {
      const until = Number(blocked);
      if (until > t) {
        return { allowed: false, remaining: 0, resetAt: t + this.rule.windowMs, blockedUntil: until, reason: "blocked" };
      }
    }

    // Increment the window counter
    const count = await this.store.incr(key, ttlSec, n);
    const resetAt = (Math.floor(t / this.rule.windowMs) + 1) * this.rule.windowMs;

    if (count > this.rule.max) {
      // Optionally set a block TTL
      if (this.rule.blockDurationMs && this.rule.blockDurationMs > 0) {
        const until = t + this.rule.blockDurationMs;
        await this.store.set(blockK, String(until), Math.ceil(this.rule.blockDurationMs / 1000));
      }
      return { allowed: false, remaining: 0, resetAt, blockedUntil: this.rule.blockDurationMs ? t + this.rule.blockDurationMs : undefined, reason: "exceeded" };
    }

    const remaining = Math.max(0, this.rule.max - count);
    return { allowed: true, remaining, resetAt };
  }
}

// -------------------------- Convenience ------------------------------

export interface HttpLike {
  setHeader?(name: string, value: string): void;
}

export function applyHeaders(res: HttpLike, id: string, rule: RateLimitRule, result: RateLimitResult) {
  try {
    if (!res?.setHeader) return;
    res.setHeader("X-RateLimit-Limit", String(rule.max));
    res.setHeader("X-RateLimit-Remaining", String(result.remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(result.resetAt / 1000)));
    if (!result.allowed) {
      const ra = retryAfterSeconds(result);
      if (ra != null) res.setHeader("Retry-After", String(ra));
    }
  } catch (e) {
    log.warn("rate-limit headers failed", { err: e });
  }
}

// Example usage:
// const limiter = new RateLimiter({ windowMs: 60_000, max: 30, blockDurationMs: 300_000, prefix: 'api' }, new UpstashKVStore());
// const res = await limiter.consume(userId);
// if (!res.allowed) return Response.json({ error: 'Too Many Requests' }, { status: 429, headers: buildHeaders(res) });
