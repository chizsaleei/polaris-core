// polaris-core/src/server/routes/admin/drills/set-publish.ts
import type { Request, Response } from "express";
import { Router } from "express";
import type { PostgrestError } from "@supabase/supabase-js";
import type { ParamsDictionary } from "express-serve-static-core";
import { createClient } from "../../../../lib/supabase";

const router = Router();
const supabase = createClient();

type AdminSetRequest = Request<ParamsDictionary, unknown, SetPublishBody> & { user?: { id?: string | null } };

interface SetPublishBody {
  setId?: string | number;
  targetState?: string;
  makePublic?: boolean;
  changelog?: string;
}

interface DrillSetRow {
  version?: number | null;
  is_public?: boolean | null;
  published_at?: string | null;
  changelog?: string | null;
  state?: string | null;
  workflow_state?: string | null;
}

type DrillSetPatch = {
  state?: string;
  workflow_state?: string;
  is_public?: boolean;
  published_at?: string | null;
  version: number;
  changelog: string;
  updated_at: string;
};

/**
 * POST /admin/drills/set-publish
 *
 * Change a drill set workflow state. Default is "published".
 *
 * Body:
 *  - setId: string | number (required)
 *  - targetState?: "published" | "approved" | "in_review" | "auto_qa" | "draft" | "deprecated" (default "published")
 *  - makePublic?: boolean  (override visibility; defaults true if targetState = published, false if deprecated, unchanged otherwise)
 *  - changelog?: string
 *
 * Auth: admin only (x-user-id + is_admin checks)
 */

router.post("/", (req: Request, res: Response) => {
  void handleSetPublish(req as AdminSetRequest, res);
});

const handleSetPublish = async (req: AdminSetRequest, res: Response): Promise<void> => {
  try {
    const uid = readUserId(req.user?.id) ?? readUserId(req.header("x-user-id"));
    if (!(await isAdminUser(uid))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const rawBody = req.body;
    const body: Partial<SetPublishBody> =
      rawBody && typeof rawBody === "object" ? rawBody : {};
    const rawSetId = body.setId;
    if (rawSetId === undefined || rawSetId === null || rawSetId === "") {
      res.status(400).json({ error: "missing_setId" });
      return;
    }
    const setId = String(rawSetId);

    const targetState = normalizeState(body.targetState) || "published";
    const makePublic =
      typeof body.makePublic === "boolean"
        ? body.makePublic
        : targetState === "published"
          ? true
          : targetState === "deprecated"
            ? false
            : undefined;

    const changelogIn = safeString(body.changelog);
    const nowIso = new Date().toISOString();

    const table = await chooseSetTable();
    if (!table) {
      res.status(500).json({ error: "sets_table_not_found" });
      return;
    }
    const idCol = await findIdColumn(table);
    if (!idCol) {
      res.status(500).json({ error: "id_column_not_found" });
      return;
    }

    const currentResult = await supabase
      .from(table)
      .select("*")
      .eq(idCol, setId)
      .maybeSingle<Record<string, unknown>>();
    const currentRow = currentResult.data;
    const readErr = currentResult.error;
    if (readErr) {
      res.status(500).json({ error: "read_failed", detail: safeMsg(readErr.message) });
      return;
    }
    const current = toRecord(currentRow) as DrillSetRow | null;
    if (!current) {
      res.status(404).json({ error: "set_not_found", setId });
      return;
    }

    const nextVersion =
      typeof current.version === "number" && Number.isFinite(current.version) ? current.version + 1 : 1;

    const updatesCandidates: DrillSetPatch[] = [
      {
        state: targetState,
        is_public: makePublic ?? coerceBoolean(current.is_public) ?? (targetState === "published"),
        published_at: targetState === "published" ? nowIso : firstString(current.published_at) ?? null,
        version: nextVersion,
        changelog: appendChangelog(
          firstString(current.changelog),
          `[${nowIso}] ${uid || "admin"} • STATE → ${targetState}${changelogIn ? ` • ${changelogIn}` : ""}`,
        ),
        updated_at: nowIso,
      },
      {
        workflow_state: targetState,
        is_public: makePublic ?? coerceBoolean(current.is_public) ?? (targetState === "published"),
        published_at: targetState === "published" ? nowIso : firstString(current.published_at) ?? null,
        version: nextVersion,
        changelog: appendChangelog(
          firstString(current.changelog),
          `[${nowIso}] ${uid || "admin"} • WORKFLOW → ${targetState}${changelogIn ? ` • ${changelogIn}` : ""}`,
        ),
        updated_at: nowIso,
      },
      {
        is_public: makePublic ?? (targetState === "published"),
        version: nextVersion,
        changelog: appendChangelog(
          firstString(current.changelog),
          `[${nowIso}] ${uid || "admin"} • VISIBILITY ${makePublic ? "ON" : "OFF"}${
            changelogIn ? ` • ${changelogIn}` : ""
          }`,
        ),
        updated_at: nowIso,
      },
    ];

    let updated: DrillSetRow | null = null;
    let lastErr: PostgrestError | null = null;

    for (const patch of updatesCandidates) {
      const updateResult = await supabase
        .from(table)
        .update(patch)
        .eq(idCol, setId)
        .select("*")
        .maybeSingle<Record<string, unknown>>();

      const data = updateResult.data;
      const error = updateResult.error;

      if (!error && data) {
        updated = toRecord(data) as DrillSetRow;
        break;
      }
      lastErr = error;
    }

    if (!updated) {
      res.status(500).json({ error: "update_failed", detail: safeMsg(lastErr?.message) });
      return;
    }

    await logAdminAction({
      kind: "drill_set_state_change",
      userId: uid || null,
      setId,
      note: changelogIn || null,
      meta: { table, targetState, makePublic },
    });

    res.status(200).json({ ok: true, set: updated });
  } catch (error) {
    logError("[admin/drills/set-publish] error", error);
    res.status(500).json({ error: "internal_error" });
  }
};

export default router;

// -----------------------------------------------------------------------------
// Table and column discovery
// -----------------------------------------------------------------------------

async function chooseSetTable(): Promise<string | null> {
  const candidates = ["drill_sets", "drills_sets", "content_sets", "sets"] as const;
  for (const t of candidates) {
    try {
      const { error } = await supabase
        .from(t)
        .select("*", { count: "exact", head: true })
        .limit(0);
      if (!error) return t;
    } catch {
      // continue
    }
  }
  return null;
}

async function findIdColumn(table: string): Promise<"id" | "set_id" | "drill_set_id" | null> {
  // Try fetching with each id column; the first that returns not-null row is the winner
  const cols: Array<"id" | "set_id" | "drill_set_id"> = ["id", "set_id", "drill_set_id"];
  for (const c of cols) {
    try {
      // head select is not supported for filtering unknown column reliably, so attempt a real select with limit 0 to validate column existence
      const { error } = await supabase.from(table).select(c, { head: true, count: "exact" }).limit(0);
      if (!error) return c;
    } catch {
      // ignore
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Admin auth and audit
// -----------------------------------------------------------------------------

async function isAdminUser(userId?: string): Promise<boolean> {
  if (!userId) return false;

  // quick allow list via env
  const allow = String(process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.includes(userId)) return true;

  // rpc if available
  try {
    const rpc = await supabase.rpc("is_admin", { p_user_id: userId }).single();
    if (!rpc.error && rpc.data === true) return true;
  } catch {
    // ignore
  }

  // profiles fallback
  try {
    const prof = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("user_id", userId)
      .maybeSingle();
    const profData = toRecord(prof.data);
    if (profData && profData.is_admin === true) return true;
  } catch {
    // ignore
  }

  return false;
}

async function logAdminAction(input: {
  kind: string;
  userId: string | null;
  setId: string;
  note: string | null;
  meta?: Record<string, unknown>;
}) {
  try {
    const adminPayload = {
      user_id: input.userId,
      kind: input.kind,
      payload: {
        set_id: input.setId,
        note: input.note,
        meta: input.meta ?? null,
      },
    };
    const { error } = await supabase.from("admin_messages").insert(adminPayload);
    if (!error) return;
  } catch {
    // ignore
  }

  try {
    const eventPayload = {
      name: input.kind,
      user_id: input.userId,
      tier: "admin",
      coach_id: null,
      meta: {
        set_id: input.setId,
        note: input.note,
        meta: input.meta ?? null,
      },
    };
    await supabase.from("events").insert(eventPayload);
  } catch {
    // ignore
  }
}

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------

type DrillState = "published" | "approved" | "in_review" | "auto_qa" | "draft" | "deprecated";

function normalizeState(s: unknown): DrillState | null {
  if (!s || typeof s !== "string") return null;
  const k = s.toLowerCase();
  const allowed: DrillState[] = ["published", "approved", "in_review", "auto_qa", "draft", "deprecated"];
  return allowed.includes(k as DrillState) ? (k as DrillState) : null;
}

function appendChangelog(current: string | null | undefined, entry: string) {
  if (!current) return entry;
  if (typeof current === "string" && current.trim().length > 0) {
    return `${current}\n${entry}`.slice(0, 20000);
  }
  return entry;
}

function safeString(v: unknown): string | null {
  return typeof v === "string" ? v.trim().slice(0, 2000) : null;
}

function safeMsg(msg?: string) {
  return String(msg || "").replace(/\s+/g, " ").slice(0, 200);
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return undefined;
}

function readUserId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
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

function toRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function logError(label: string, error: unknown) {
  console.error(label, error);
}
