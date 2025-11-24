// src/server/routes/payments/portal.ts
/**
 * Customer portal session endpoint.
 *
 * Body:
 *   {
 *     userId: string,
 *     provider?: 'paypal'|'paymongo',
 *     returnUrl?: string,
 *     customerId?: string // provider-specific id if known
 *   }
 *
 * Returns provider-specific billing portal URL.
 */

import { Router, type Request, type Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";
import { createPortal, parseProvider, getActiveProviders, type Provider } from "../../../lib/payments";
import { ENV } from "../../../config/env";
import type { AuthInfo } from "../../middleware/auth";

const router = Router();
type PortalRequest = Request<ParamsDictionary> & { user?: AuthInfo };

router.post("/", (req: PortalRequest, res: Response) => {
  const headerUser = req.header("x-user-id");
  const contextUserId =
    req.user?.userId ?? (typeof headerUser === "string" ? headerUser.trim() : undefined);

  void runWithRequestContext(
    { headers: req.headers, user_id: contextUserId },
    async () => {
      try {
        const payload = sanitizePayload(req.body);
        const issues = validatePayload(payload);
        if (issues.length) {
          sendError(res, 400, "invalid_payload", issues.join(" | "));
          return;
        }

        const provider = chooseProvider(payload.provider);
        const session = await createPortal(
          {
            userId: payload.userId,
            customerId: payload.customerId,
            returnUrl: payload.returnUrl ?? defaultReturnUrl(),
          },
          provider,
        );

        res.status(200).json({
          ok: true,
          data: {
            provider: session.provider,
            url: session.url,
          },
          correlation_id: getCorrelationId(),
        });
      } catch (error: unknown) {
        const parsed = parseHttpError(error);
        const message =
          parsed.status === 500 ? "Portal session failed." : parsed.message ?? "Portal session failed.";
        if (parsed.status >= 500) log.error("payments/portal error", { err: safeError(error) });
        sendError(res, parsed.status, parsed.code, message);
      }
    },
  );
});

export default router;

// -----------------------------------------------------------------------------
// Payload helpers
// -----------------------------------------------------------------------------

interface PortalPayload {
  userId: string;
  provider?: Provider;
  returnUrl?: string;
  customerId?: string;
}

function sanitizePayload(body: unknown): PortalPayload {
  const source = isRecord(body) ? body : {};
  const userId = firstString(source.userId ?? source.user_id) ?? "";
  const providerInput = firstString(source.provider);
  const provider = parseProvider(providerInput);
  const returnUrl = normalizeUrl(firstString(source.returnUrl ?? source.return_url));
  const customerId = firstString(source.customerId ?? source.customer_id);
  return { userId, provider, returnUrl, customerId };
}

function validatePayload(payload: PortalPayload) {
  const issues: string[] = [];
  if (!payload.userId) issues.push("userId is required");
  return issues;
}

function chooseProvider(preferred?: Provider) {
  if (preferred && getActiveProviders().includes(preferred)) return preferred;
  const active = getActiveProviders();
  if (!active.length) throw makeHttpError(503, "no_provider", "No billing providers configured.");
  return active[0];
}

function defaultReturnUrl() {
  const base = ENV.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_BASE_URL || "";
  if (!base) return "/account/billing";
  return `${base.replace(/\/$/, "")}/account/billing`;
}

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------

function sendError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({
    ok: false,
    error: { code, message },
    correlation_id: getCorrelationId(),
  });
}

function makeHttpError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const str = firstString(entry);
      if (str) return str;
    }
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const str = String(value).trim();
    return str.length ? str : undefined;
  }
  return undefined;
}

function normalizeUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseHttpError(error: unknown): { status: number; code: string; message?: string } {
  if (isRecord(error)) {
    const status = typeof error.status === "number" ? error.status : 500;
    const code = typeof error.code === "string" ? error.code : "internal_error";
    const message = typeof error.message === "string" ? error.message : undefined;
    return { status, code, message };
  }
  return { status: 500, code: "internal_error" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
