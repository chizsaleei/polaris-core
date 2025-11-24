// polaris-core/src/server/routes/account/profile.ts

import {
  Router,
  type Request,
  type Response,
  type RequestHandler,
} from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import type { ParsedQs } from "qs";
import { createClient } from "../../../lib/supabase";
import type { ProfileRow } from "../../../types";

const router = Router();
const supabase = createClient();

// ---------- Shared shapes ----------

export type AccountProfileErrorCode =
  | "missing_user_id"
  | "invalid_body"
  | "internal_error";

export interface AccountProfileErrorResponse {
  error: AccountProfileErrorCode;
}

export interface AccountProfileSuccessResponse {
  ok: true;
  profile: ProfileRow | null;
}

export type AccountProfileResponse =
  | AccountProfileSuccessResponse
  | AccountProfileErrorResponse;

// ---------- Auth helper ----------

type RequestWithUser = Request & { user?: { id?: unknown; userId?: unknown } };

export function readUserId(req: Request): string | null {
  const user = (req as RequestWithUser).user;
  if (!user) return null;
  if (typeof user.userId === "string" && user.userId.length > 0) {
    return user.userId;
  }
  if (typeof user.id === "string" && user.id.length > 0) {
    return user.id;
  }
  return null;
}

type AccountProfileQuery = ParsedQs & { userId?: string };

// ---------- Update body shape ----------

export interface AccountProfileUpdateBody {
  timezone?: string;
  country_code?: string;
  currency_code?: string;
  goal?: string;
  daily_target_minutes?: number;
  reminder_time_local?: string; // "HH:MM"
  practice_focus?: string;
}

// ---------- GET handler (read profile) ----------

export async function handleAccountProfile(
  req: Request<ParamsDictionary, AccountProfileResponse, undefined, AccountProfileQuery>,
  res: Response<AccountProfileResponse>,
): Promise<void> {
  try {
    const headerUser = readUserId(req);
    const queryUser =
      typeof req.query.userId === "string" ? req.query.userId : undefined;
    const userId = headerUser || queryUser || null;

    if (!userId) {
      res.status(401).json({ error: "missing_user_id" });
      return;
    }

    const profileResp = await supabase
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .maybeSingle();

    if (profileResp.error) {
      console.error("[account/profile] select error", profileResp.error);
      res.status(500).json({ error: "internal_error" });
      return;
    }

    const profile = toProfileRow(profileResp.data);

    res.status(200).json({
      ok: true,
      profile,
    });
  } catch (err) {
    console.error("[account/profile] unexpected", err);
    res.status(500).json({ error: "internal_error" });
  }
}

// ---------- PUT handler (update profile) ----------

export async function handleAccountProfileUpdate(
  req: Request<
    ParamsDictionary,
    AccountProfileResponse,
    AccountProfileUpdateBody,
    AccountProfileQuery
  >,
  res: Response<AccountProfileResponse>,
): Promise<void> {
  try {
    const userId = readUserId(req);

    if (!userId) {
      res.status(401).json({ error: "missing_user_id" });
      return;
    }

    const body = req.body;

    if (!body || typeof body !== "object") {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    // Build a partial update object so we only send defined keys
    const update: ProfileUpdatePatch = {};

    if (typeof body.timezone === "string") {
      update.timezone = body.timezone;
    }
    if (typeof body.country_code === "string") {
      update.country_code = body.country_code;
    }
    if (typeof body.currency_code === "string") {
      update.currency_code = body.currency_code;
    }
    if (typeof body.goal === "string") {
      update.goal = body.goal;
    }
    if (
      typeof body.daily_target_minutes === "number" &&
      Number.isFinite(body.daily_target_minutes)
    ) {
      update.daily_target_minutes = body.daily_target_minutes;
    }
    if (typeof body.reminder_time_local === "string") {
      update.reminder_time_local = body.reminder_time_local;
    }
    if (typeof body.practice_focus === "string") {
      update.practice_focus = body.practice_focus;
    }

    if (Object.keys(update).length === 0) {
      // Nothing to update, just return current profile
      const currentResp = await supabase
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .maybeSingle();

      if (currentResp.error) {
        console.error("[account/profile] select after empty update", currentResp.error);
        res.status(500).json({ error: "internal_error" });
        return;
      }

      const profile = toProfileRow(currentResp.data);

      res.status(200).json({
        ok: true,
        profile,
      });
      return;
    }

    const updateResp = await supabase
      .from("profiles")
      .update(update)
      .eq("id", userId)
      .select("*")
      .maybeSingle();

    if (updateResp.error) {
      console.error("[account/profile] update error", updateResp.error);
      res.status(500).json({ error: "internal_error" });
      return;
    }

    const profile = toProfileRow(updateResp.data);

    res.status(200).json({
      ok: true,
      profile,
    });
  } catch (err) {
    console.error("[account/profile] unexpected update", err);
    res.status(500).json({ error: "internal_error" });
  }
}

// ---------- Router wiring ----------

type AccountProfileGetHandler = RequestHandler<
  ParamsDictionary,
  AccountProfileResponse,
  undefined,
  AccountProfileQuery
>;

type AccountProfilePutHandler = RequestHandler<
  ParamsDictionary,
  AccountProfileResponse,
  AccountProfileUpdateBody,
  AccountProfileQuery
>;

router.get(
  "/",
  ((req, res) => {
    void handleAccountProfile(req, res);
  }) as AccountProfileGetHandler,
);

router.put(
  "/",
  ((req, res) => {
    void handleAccountProfileUpdate(req, res);
  }) as AccountProfilePutHandler,
);

export const accountProfileRouter = router;
export default router;

type ProfileUpdatePatch = Partial<
  Pick<
    ProfileRow,
    | "timezone"
    | "country_code"
    | "currency_code"
    | "goal"
    | "daily_target_minutes"
    | "reminder_time_local"
    | "practice_focus"
  >
>;

function toProfileRow(value: unknown): ProfileRow | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  return value as ProfileRow;
}
