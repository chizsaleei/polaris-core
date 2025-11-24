/**
 * Polaris Core — structured logger
 * Lightweight, dependency-free JSON logger with redaction, request context,
 * and optional pretty output in development. Production prints newline-delimited JSON.
 *
 * Usage:
 *   import { log, createLogger, runWithRequestContext, timeAsync } from "../lib/logger";
 *   log.info("server started", { port: 8787 });
 *   await runWithRequestContext({ headers: req.headers }, async () => {
 *     log.debug("handling request", { path: req.url });
 *   });
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

// ----------------------------- Types ---------------------------------

export type LogLevelName = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

type LevelNum = 10 | 20 | 30 | 40 | 50 | 60;

type Bindings = Record<string, unknown>;

export interface Logger {
  level: LogLevelName;
  isLevelEnabled(level: LogLevelName): boolean;
  child(bindings?: Bindings): Logger;
  trace(msg: string, fields?: Bindings): void;
  debug(msg: string, fields?: Bindings): void;
  info(msg: string, fields?: Bindings): void;
  warn(msg: string, fields?: Bindings): void;
  error(msg: string, fields?: Bindings): void;
  fatal(msg: string, fields?: Bindings): void;
  time(name: string): { end: (extra?: Bindings) => void };
  timeAsync<T>(name: string, fn: () => Promise<T>, extra?: Bindings): Promise<T>;
}

// --------------------------- Internals -------------------------------

const LEVELS: Record<LogLevelName, LevelNum> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const REVERSE_LEVELS: Record<LevelNum, LogLevelName> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

const DEFAULT_LEVEL: LogLevelName = (process.env.LOG_LEVEL as LogLevelName) || "info";
const SERVICE = process.env.SERVICE_NAME || "polaris-core";
const ENV = process.env.VERCEL_ENV || process.env.NODE_ENV || "development";

// Keys that will be redacted (case insensitive, deep)
const REDACT_KEYS = new Set([
  "password",
  "authorization",
  "apikey",
  "api_key",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "client_secret",
  "webhook_secret",
  "supabase_service_role_key",
  "supabase_jwt_secret",
  "paymongo_secret_key",
  "paypal_client_secret",
]);

const ctx = new AsyncLocalStorage<{
  correlation_id: string;
  user_id?: string;
  session_id?: string;
  bindings?: Bindings;
}>();

type OtelSpanContext = {
  traceId?: string;
  spanId?: string;
};

type OtelSpan = {
  spanContext?: () => OtelSpanContext | undefined;
};

type OtelTrace = {
  getActiveSpan?: () => OtelSpan | undefined;
};

type OtelApi = {
  trace?: OtelTrace;
};

let otelApi: OtelApi | null = null;

export function registerOtelApi(api: OtelApi | null) {
  otelApi = api;
}

// Optional OpenTelemetry trace extraction without hard dependency
function getOtelContext(): { trace_id?: string; span_id?: string } {
  const api = otelApi;
  if (!api?.trace) return {};
  const span = api.trace.getActiveSpan?.();
  const sc = span?.spanContext?.();
  if (sc?.traceId) {
    return { trace_id: sc.traceId, span_id: sc.spanId };
  }
  return {};
}

function redact(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Error) return serializeError(value);
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = "[redacted]";
    } else if (typeof v === "object" && v !== null) {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function serializeError(err: unknown) {
  if (!(err instanceof Error)) return err;
  const e = err as Error & { cause?: unknown };
  const stack = (e.stack || "").split("\n").slice(0, 10).join("\n");
  return {
    name: e.name,
    message: e.message,
    stack,
    cause: typeof e.cause === "object" ? redact(e.cause as object) : e.cause,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function levelNum(name: LogLevelName): LevelNum {
  return LEVELS[name];
}

function isTTY() {
  return !!process?.stdout?.isTTY;
}

function color(level: LogLevelName) {
  const codes: Record<LogLevelName, string> = {
    trace: "\x1b[90m",
    debug: "\x1b[36m",
    info: "\x1b[32m",
    warn: "\x1b[33m",
    error: "\x1b[31m",
    fatal: "\x1b[41m\x1b[37m",
  };
  return codes[level] || "";
}

function reset() {
  return "\x1b[0m";
}

type HeadersLike = {
  get(name: string): string | null | undefined;
};

function isHeadersLike(value: unknown): value is HeadersLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { get?: unknown }).get === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// ---------------------------- Factory --------------------------------

class PolarisLogger implements Logger {
  level: LogLevelName;
  private base: Bindings;

  constructor(level: LogLevelName, bindings?: Bindings) {
    this.level = level;
    this.base = { service: SERVICE, env: ENV, pid: process.pid, ...bindings };
  }

  isLevelEnabled(level: LogLevelName) {
    return levelNum(level) >= levelNum(this.level);
  }

  child(bindings?: Bindings): Logger {
    return new PolarisLogger(this.level, { ...this.base, ...bindings });
  }

  private write(level: LogLevelName, msg: string, fields?: Bindings) {
    if (!this.isLevelEnabled(level)) return;

    const store = ctx.getStore();
    const { trace_id, span_id } = getOtelContext();

    // Merge and redact context fields safely into a plain object
    const mergedFields = redact({
      ...(store?.bindings || {}),
      ...(fields || {}),
    }) as Record<string, unknown>;

    const rec = {
      ts: nowIso(),
      level,
      lvl: LEVELS[level],
      msg,
      ...this.base,
      correlation_id: store?.correlation_id,
      user_id: store?.user_id,
      session_id: store?.session_id,
      trace_id,
      span_id,
      ...mergedFields,
    } as Record<string, unknown>;

    if (ENV === "production" || !isTTY()) {
      process.stdout.write(JSON.stringify(rec) + "\n");
    } else {
      const c = color(level);
      const head = `${c}${REVERSE_LEVELS[LEVELS[level]].toUpperCase()}${reset()}`;
      const line = `${new Date(rec.ts as string).toISOString()} ${head} ${msg}`;
      // Pretty print small payloads, JSON for larger ones
      const { ts: _ts, level: _level, lvl: _lvl, msg: _msg, ...rest } = rec;
      const restStr = Object.keys(rest).length ? "\n  " + JSON.stringify(rest, null, 2) : "";
      process.stdout.write(line + restStr + "\n");
    }
  }

  trace(msg: string, fields?: Bindings) { this.write("trace", msg, fields); }
  debug(msg: string, fields?: Bindings) { this.write("debug", msg, fields); }
  info(msg: string, fields?: Bindings)  { this.write("info", msg, fields); }
  warn(msg: string, fields?: Bindings)  { this.write("warn", msg, fields); }
  error(msg: string, fields?: Bindings) { this.write("error", msg, fields); }
  fatal(msg: string, fields?: Bindings) { this.write("fatal", msg, fields); }

  time(name: string) {
    const start = process.hrtime.bigint();
    return {
      end: (extra?: Bindings) => {
        const durMs = Number(process.hrtime.bigint() - start) / 1_000_000;
        this.debug("timing", { metric: name, duration_ms: Math.round(durMs), ...(extra || {}) });
      },
    };
  }

  async timeAsync<T>(name: string, fn: () => Promise<T>, extra?: Bindings): Promise<T> {
    const t = this.time(name);
    try {
      const result = await fn();
      t.end({ success: true, ...(extra || {}) });
      return result;
    } catch (err) {
      t.end({ success: false, err: serializeError(err), ...(extra || {}) });
      throw err;
    }
  }
}

// Singleton logger used across the service
export const log: Logger = new PolarisLogger(DEFAULT_LEVEL);

export function createLogger(opts?: { level?: LogLevelName; bindings?: Bindings }): Logger {
  return new PolarisLogger(opts?.level || DEFAULT_LEVEL, opts?.bindings);
}

// ------------------------ Request context -----------------------------

export interface ContextInit {
  correlation_id?: string;
  user_id?: string;
  session_id?: string;
  headers?: Record<string, unknown> | Headers;
  bindings?: Bindings;
}

function headerLookup(h?: ContextInit["headers"], key?: string): string | undefined {
  if (!h || !key) return undefined;
  if (isHeadersLike(h)) {
    const value = h.get(key);
    return typeof value === "string" ? value : undefined;
  }
  if (!isRecord(h)) return undefined;
  const normalized = key.toLowerCase();
  const record: Record<string, unknown> = h;
  const candidates = [normalized, key, normalized.replace(/_/g, "-")];
  for (const candidate of candidates) {
    const value = record[candidate];
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return undefined;
}

export function runWithRequestContext<T>(init: ContextInit, fn: () => T): T {
  const cid =
    init.correlation_id ||
    headerLookup(init.headers, "x-correlation-id") ||
    headerLookup(init.headers, "x-request-id") ||
    randomUUID();

  const store = {
    correlation_id: cid,
    user_id: init.user_id,
    session_id: init.session_id,
    bindings: init.bindings,
  };

  return ctx.run(store, fn);
}

export function getCorrelationId(): string | undefined {
  return ctx.getStore()?.correlation_id;
}

export function bindToContext(extra: Bindings) {
  const store = ctx.getStore();
  if (!store) return;
  store.bindings = { ...(store.bindings || {}), ...extra };
}

// Convenient helpers for error serialization and redaction when logging
export function safeError(err: unknown) {
  return serializeError(err);
}

export function safeFields(fields?: Bindings): Bindings | undefined {
  return fields ? (redact(fields) as Bindings) : undefined;
}

// ---------------------------- Examples --------------------------------
// log.info("service boot", { version: process.env.npm_package_version });
// const { end } = log.time("db.connect");
// try { await connect(); end({ ok: true }); } catch (e) { end({ ok: false, err: safeError(e) }); }
