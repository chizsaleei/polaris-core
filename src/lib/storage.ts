/**
 * Polaris Core - Supabase Storage helpers
 * Framework agnostic, server side only. Never expose service role keys to clients.
 *
 * What you get:
 *  - Safe object keys and simple content type detection
 *  - Public URL, signed URL, and signed upload URL helpers
 *  - JSON and binary upload wrappers (admin/service role)
 *  - Delete and list
 *
 * Usage (admin/service role):
 *   import { admin } from "./storage";
 *   const key = newObjectKey({ prefix: `users/${userId}/sessions`, filename: "audio.webm" });
 *   await admin.putFile(BUCKETS.uploads, key, fileBlob, { upsert: true });
 *   const { url } = await admin.signedUrl(BUCKETS.uploads, key, 60);
 *
 * Usage (RLS user client): pass your own supabase client to `client()`.
 */

import { randomUUID } from "node:crypto";
import { log, safeError } from "./logger";
import { BUCKETS } from "./constants";

// Type-only import to avoid hard dependency if not installed in this package
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import type { SupabaseClient } from "@supabase/supabase-js";

// ------------------------------ Types ---------------------------------

export interface PutOptions {
  upsert?: boolean;
  contentType?: string;
  cacheControl?: string; // e.g., "max-age=31536000, immutable"
}

export interface SignedUrlResult {
  url: string;
  expiresAt: string;
}

export interface StorageListResult {
  keys: string[];
  nextPageToken?: string | null;
}

export interface StorageApi {
  putJson: (bucket: string, key: string, data: unknown, opts?: PutOptions) => Promise<void>;
  putFile: (
    bucket: string,
    key: string,
    data: Blob | ArrayBuffer | Uint8Array,
    opts?: PutOptions,
  ) => Promise<void>;
  delete: (bucket: string, keyOrKeys: string | string[]) => Promise<void>;
  list: (bucket: string, prefix?: string, limit?: number, token?: string) => Promise<StorageListResult>;
  publicUrl: (bucket: string, key: string) => string;
  signedUrl: (bucket: string, key: string, expiresInSeconds?: number) => Promise<SignedUrlResult>;
  signedUploadUrl: (bucket: string, key: string, expiresInSeconds?: number) => Promise<SignedUrlResult>;
}

/**
 * Minimal shape of objects returned by Supabase storage list.
 */
interface StorageListedObject {
  name: string;
}

type SupabaseAdminFactory = () => SupabaseClient<any, any, any> | Promise<SupabaseClient<any, any, any>>;

interface SupabaseAdminModule {
  serverAdmin?: SupabaseAdminFactory | SupabaseClient<any, any, any>;
  admin?: SupabaseAdminFactory | SupabaseClient<any, any, any>;
  getAdminClient?: SupabaseAdminFactory;
  // Allow other exports without typing them
  [key: string]: unknown;
}

/**
 * Minimal interface for bucket client that supports signed upload URLs.
 */
interface SignedUploadBucketApi {
  createSignedUploadUrl: (
    path: string,
    options?: { upsert?: boolean; expiresIn?: number },
  ) => Promise<{ data: unknown; error: StorageErrorLike | null }>;
}

interface SignedUploadData {
  signedUrl?: string;
  url?: string;
  [key: string]: unknown;
}

type StorageErrorLike = Error | { message?: string };

// -------------------------- Entry points ------------------------------

/**
 * Use the service role admin client exported by ./supabase at runtime.
 * We lazy import to avoid circular dependencies during build.
 */
async function getAdminClient(): Promise<SupabaseClient<any, any, any>> {
  const mod = (await import("./supabase")) as SupabaseAdminModule;

  const candidate = mod.serverAdmin ?? mod.admin ?? mod.getAdminClient;
  if (!candidate) {
    throw new Error("supabase admin client factory not found (serverAdmin/admin/getAdminClient)");
  }

  if (typeof candidate === "function") {
    const client = await candidate();
    return client;
  }

  return candidate;
}

/**
 * Wrap an existing supabase client (RLS user or service).
 */
export function client(sb: SupabaseClient<any, any, any>): StorageApi {
  return makeApi(() => Promise.resolve(sb));
}

/**
 * Admin/service role API. Do not call from the browser.
 */
export const admin: StorageApi = makeApi(getAdminClient);

function makeApi(getClient: () => Promise<SupabaseClient<any, any, any>>): StorageApi {
  return {
    async putJson(bucket, key, data, opts) {
      const c = await getClient();
      const body = new Blob([JSON.stringify(data)], {
        type: opts?.contentType || "application/json",
      });
      await upload(c, bucket, key, body, opts);
    },

    async putFile(bucket, key, data, opts) {
      const c = await getClient();
      const blob = toBlob(data, opts?.contentType);
      await upload(c, bucket, key, blob, opts);
    },

    async delete(bucket, keyOrKeys) {
      const c = await getClient();
      const arr = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      const { error } = await c.storage.from(bucket).remove(arr);
      if (error) throw error;
    },

    async list(bucket, prefix = "", limit = 100, token?: string) {
      const c = await getClient();
      const { data, error } = await c.storage.from(bucket).list(normalizePrefix(prefix), {
        limit,
        offset: token ? Number(token) : 0,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw error;

      const files: StorageListedObject[] = (data ?? []).map((item) => ({ name: item.name }));
      const keys = files.map((d) => join(prefix, d.name));

      // Storage list is folder scoped; emulate a simple offset token
      const nextPageToken =
        data && data.length === limit ? String((token ? Number(token) : 0) + limit) : null;

      return { keys, nextPageToken };
    },

    publicUrl(bucket, key) {
      const k = sanitizeKey(key);
      const host = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
      const origin = host.replace(/\/$/, "");
      return `${origin}/storage/v1/object/public/${bucket}/${k}`;
    },

    async signedUrl(bucket, key, expiresInSeconds = 60) {
      const c = await getClient();
      const { data, error } = await c.storage
        .from(bucket)
        .createSignedUrl(sanitizeKey(key), expiresInSeconds);

      if (error || !data) {
        throw error ?? new Error("createSignedUrl failed");
      }

      return { url: data.signedUrl, expiresAt: toExpiresAt(expiresInSeconds) };
    },

    async signedUploadUrl(bucket, key, expiresInSeconds = 600) {
      const c = await getClient();
      const bucketClient = c.storage.from(bucket) as unknown as SignedUploadBucketApi;

      const { data, error } = await bucketClient.createSignedUploadUrl(sanitizeKey(key), {
        upsert: true,
        expiresIn: expiresInSeconds,
      });

      if (error) {
        throw toError(error, "createSignedUploadUrl failed");
      }

      const raw = data as SignedUploadData | string;
      let url: string;

      if (typeof raw === "string") {
        url = raw;
      } else if (raw.signedUrl) {
        url = raw.signedUrl;
      } else if (raw.url) {
        url = raw.url;
      } else {
        throw new Error("createSignedUploadUrl returned no URL");
      }

      return { url, expiresAt: toExpiresAt(expiresInSeconds) };
    },
  };
}

// --------------------------- Core helpers -----------------------------

async function upload(
  c: SupabaseClient<any, any, any>,
  bucket: string,
  key: string,
  blob: Blob,
  opts?: PutOptions,
) {
  const k = sanitizeKey(key);
  const type = opts?.contentType || detectContentType(k) || "application/octet-stream";
  const { error } = await c.storage.from(bucket).upload(k, blob, {
    upsert: !!opts?.upsert,
    cacheControl: opts?.cacheControl || "public, max-age=31536000, immutable",
    contentType: type,
  });

  if (error) throw error;
}

// ------------------------- Key utilities ------------------------------

export function newObjectKey(input?: {
  prefix?: string; // e.g., "users/<id>/sessions"
  filename?: string; // include to keep extension
  ext?: string; // override extension without filename
  date?: Date; // default now
}): string {
  const d = input?.date || new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const base = `${yyyy}/${mm}/${dd}`;
  const id = randomUUID();
  const ext = sanitizeExt(input?.ext || extFromFilename(input?.filename));
  const parts = [trimSlashes(input?.prefix || ""), base, `${id}${ext ? "." + ext : ""}`].filter(Boolean);
  return parts.join("/");
}

export function sanitizeKey(key: string): string {
  const k = key.replace(/\\/g, "/").replace(/\.+/g, ".");
  const parts = k.split("/").filter((p) => p && p !== "." && p !== "..");
  return parts.join("/");
}

function normalizePrefix(prefix: string): string {
  return trimSlashes(prefix);
}

function trimSlashes(s: string): string {
  return (s || "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function join(a: string, b: string): string {
  return [trimSlashes(a), trimSlashes(b)].filter(Boolean).join("/");
}

// ----------------------- Content type helpers -------------------------

export function detectContentType(pathOrName: string): string | undefined {
  const ext = extFromFilename(pathOrName);
  switch (ext) {
    case "json":
      return "application/json";
    case "txt":
      return "text/plain; charset=utf-8";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "ogg":
      return "audio/ogg";
    case "opus":
      return "audio/opus";
    case "m4a":
      return "audio/mp4";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "pdf":
      return "application/pdf";
    default:
      return undefined;
  }
}

function extFromFilename(name?: string): string | undefined {
  if (!name) return undefined;
  const i = name.lastIndexOf(".");
  if (i < 0) return undefined;
  return name.slice(i + 1).toLowerCase();
}

function sanitizeExt(ext?: string): string | undefined {
  if (!ext) return undefined;
  return ext.replace(/^\./, "").toLowerCase();
}

// ----------------------------- Validation -----------------------------

// Optional allow list from env (comma separated patterns like "image/*,application/pdf")
const ALLOWED_MIME_PATTERNS: string[] = (() => {
  const raw = process.env.ALLOWED_UPLOAD_MIME || process.env.ALLOWED_MIME || "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
})();

export function validateMime(mime: string): boolean {
  try {
    const allow = ALLOWED_MIME_PATTERNS;
    if (!allow.length) return true;
    return allow.some((p) => matchMime(p, mime));
  } catch (e) {
    log.warn("validateMime failed", { err: safeError(e) });
    return true;
  }
}

function matchMime(pattern: string, value: string): boolean {
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2).toLowerCase();
    return value.toLowerCase().startsWith(`${base}/`);
  }
  return pattern.toLowerCase() === value.toLowerCase();
}

// ------------------------------ Blobs ---------------------------------

function toBlob(data: Blob | ArrayBuffer | Uint8Array, contentType?: string): Blob {
  if (data instanceof Blob) return data;

  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const ab =
    u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
      ? (u8.buffer as ArrayBuffer)
      : (u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer);

  return new Blob([ab], { type: contentType || "application/octet-stream" });
}

// --------------------------- Small helpers ----------------------------

function toExpiresAt(expiresInSeconds: number): string {
  const d = new Date();
  d.setUTCSeconds(d.getUTCSeconds() + Math.max(0, Math.floor(expiresInSeconds)));
  return d.toISOString();
}

function toError(err: StorageErrorLike, fallback: string): Error {
  if (err instanceof Error) return err;
  const message = err?.message || fallback;
  return new Error(message);
}

// Re-export bucket constants to make call sites nicer
export { BUCKETS };
