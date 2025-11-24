// src/config/cors.ts
/**
 * Polaris Core - CORS config for Express
 * Used by src/server/index.ts via: app.use(cors(corsConfig()))
 */

import type { CorsOptions } from "cors";
import { allowedOrigins } from "./env";

const DEFAULT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const DEFAULT_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "Accept",
  "X-Requested-With",
];
const DEFAULT_EXPOSED_HEADERS = ["Content-Length", "Content-Type", "ETag", "Link"];

/** Build an Express cors() options object */
export function corsConfig(overrides?: Partial<CorsOptions>): CorsOptions {
  const origins = new Set(allowedOrigins());

  const origin: CorsOptions["origin"] = (reqOrigin, cb) => {
    if (!reqOrigin) return cb(null, true); // server to server or curl
    try {
      const u = new URL(reqOrigin);
      const host = `${u.protocol}//${u.host}`;
      return cb(null, origins.has(host));
    } catch {
      return cb(null, false);
    }
  };

  return {
    origin,
    credentials: true,
    methods: DEFAULT_METHODS,
    allowedHeaders: DEFAULT_ALLOWED_HEADERS,
    exposedHeaders: DEFAULT_EXPOSED_HEADERS,
    maxAge: 60 * 60 * 24, // 1 day
    ...overrides,
  };
}
