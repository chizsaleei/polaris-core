// polaris-core/src/server/routes/admin/drills/item-update.ts
import type { Request, Response } from "express";
import { Router } from "express";
import { createClient } from "../../../../lib/supabase";

const router = Router();
const supabase = createClient();

type ItemUpdateBody = {
  id?: string | number;
  title?: string;
  type?: string;
  coachTargets?: unknown;
  skills?: unknown;
  difficulty?: number | string;
  runtimeSeconds?: number | string;
  runtimeMinutes?: number | string;
  framework?: Record<string, unknown> | null;
  rubricId?: string | number | null;
  prompt?: string;
  successCriteria?: string;
  nextOnFailure?: string;
  accessibilityNotes?: unknown;
  altPrompt?: string;
  tags?: unknown;
  isPublic?: boolean;
  nextState?: string;
  changelog?: string;
};

type ItemUpdateRequest = Request<Record<string, never>, unknown, ItemUpdateBody> & {
  user?: { id?: string | null } | null;
};

interface DrillRow extends Record<string, unknown> {
  id: string | number;
  title?: string | null;
  type?: string | null;
  coach_targets?: string[] | null;
  skills?: string[] | null;
  difficulty?: number | null;
  runtime_seconds?: number | null;
  framework?: Record<string, unknown> | null;
  rubric_id?: string | number | null;
  prompt?: string | null;
  success_criteria?: string | null;
  next_on_failure?: string | null;
  accessibility_notes?: string[] | null;
  alt_prompt?: string | null;
  tags?: string[] | null;
  is_public?: boolean | null;
  state?: string | null;
  workflow_state?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  published_by?: string | null;
  published_at?: string | null;
  version?: number | null;
  changelog?: string | null;
  updated_at?: string | null;
}

interface ProfileRow extends Record<string, unknown> {
  is_admin: boolean | null;
}

const WORKFLOW_ORDER = ["draft", "auto_qa", "in_review", "approved", "published", "deprecated"] as const;
type WorkflowState = (typeof WORKFLOW_ORDER)[number];
const WORKFLOW_SET = new Set<WorkflowState>(WORKFLOW_ORDER);

type AdminLogPayload = {
  drill_id: string;
  from: string;
  to: string;
  note: string | null;
};

type AdminMessageInsert = {
  user_id: string | null;
  kind: string;
  payload: AdminLogPayload;
};

type EventInsert = {
  name: "admin_drill_updated";
  user_id: string | null;
  tier: "admin";
  coach_id: string | null;
  meta: AdminLogPayload;
};

/**
 * POST /admin/drills/item-update
 *
 * Partially update a drill item. Only provided fields are patched.
 */
router.post("/", (req: ItemUpdateRequest, res: Response) => {
  void handleItemUpdate(req, res);
});

const handleItemUpdate = async (req: ItemUpdateRequest, res: Response) => {
  try {
    const uid = resolveRequestUserId(req);
    if (!(await isAdminUser(uid))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const body = req.body ?? {};
    const id = body.id;
    if (typeof id !== "string" && typeof id !== "number") {
      res.status(400).json({ error: "missing_id" });
      return;
    }

    const loadResult = await supabase.from("drills").select("*").eq("id", id).maybeSingle();
    if (loadResult.error) {
      res.status(500).json({ error: "load_failed", detail: safeMsg(loadResult.error.message) });
      return;
    }
    if (!isDrillRow(loadResult.data)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const drill = loadResult.data;

    const nowIso = new Date().toISOString();
    const patch: Record<string, unknown> = {};
    let versionBump = false;

    assignIfProvided(patch, drill, "title", safeString(body.title));
    assignIfProvided(patch, drill, "type", safeString(body.type));

    {
      const coachTargets = toArray(body.coachTargets);
      if (coachTargets.length) assignIfProvided(patch, drill, "coach_targets", coachTargets);
    }
    {
      const skills = toArray(body.skills);
      if (skills.length) assignIfProvided(patch, drill, "skills", skills);
    }
    {
      const difficulty = toDifficulty(body.difficulty);
      if (difficulty != null) assignIfProvided(patch, drill, "difficulty", difficulty);
    }
    {
      const runtime = toRuntimeSeconds(body.runtimeSeconds, body.runtimeMinutes);
      if (runtime != null) assignIfProvided(patch, drill, "runtime_seconds", runtime);
    }
    if (isPojo(body.framework)) assignIfProvided(patch, drill, "framework", body.framework);

    if (body.rubricId != null) assignIfProvided(patch, drill, "rubric_id", body.rubricId);
    assignIfProvided(patch, drill, "prompt", safeString(body.prompt));
    assignIfProvided(patch, drill, "success_criteria", safeString(body.successCriteria));
    assignIfProvided(patch, drill, "next_on_failure", safeString(body.nextOnFailure));

    {
      const notes = toArray(body.accessibilityNotes);
      if (notes.length) assignIfProvided(patch, drill, "accessibility_notes", notes);
    }
    assignIfProvided(patch, drill, "alt_prompt", safeString(body.altPrompt));

    {
      const tags = toArray(body.tags);
      if (tags.length) assignIfProvided(patch, drill, "tags", tags);
    }

    if (typeof body.isPublic === "boolean") {
      assignIfProvided(patch, drill, "is_public", body.isPublic);
    }

    const currentState = resolveCurrentState(drill);
    const nextState = normalizeState(body.nextState);
    if (nextState && nextState !== currentState) {
      if (!isAllowedTransition(currentState, nextState)) {
        res.status(409).json({ error: "invalid_transition", from: currentState, to: nextState });
        return;
      }
      if ("state" in drill) patch.state = nextState;
      else if ("workflow_state" in drill) patch.workflow_state = nextState;

      if (nextState === "published") {
        if ("approved_by" in drill && !drill.approved_by) patch.approved_by = uid || null;
        if ("approved_at" in drill && !drill.approved_at) patch.approved_at = nowIso;
        if ("published_by" in drill) patch.published_by = uid || null;
        if ("published_at" in drill) patch.published_at = nowIso;
        if ("is_public" in drill) patch.is_public = true;
      }
      if (nextState === "approved") {
        if ("approved_by" in drill) patch.approved_by = uid || null;
        if ("approved_at" in drill) patch.approved_at = nowIso;
      }
      versionBump = true;
    }

    const changelog = safeString(body.changelog);
    if (changelog && "changelog" in drill) {
      const prev = typeof drill.changelog === "string" ? drill.changelog : "";
      const entry = `[${nowIso}] ${uid || "admin"} • UPDATE: ${changelog}`;
      patch.changelog = prev ? `${prev}\n${entry}` : entry;
      versionBump = true;
    }

    if (versionBump || hasContentChanges(patch)) {
      if ("version" in drill) {
        const currentVersion = Number(drill.version ?? 0);
        patch.version = Number.isFinite(currentVersion) ? currentVersion + 1 : 1;
      }
    }

    patch.updated_at = nowIso;

    if (Object.keys(patch).length === 1 && "updated_at" in patch) {
      res.status(400).json({ error: "no_changes" });
      return;
    }

    const updateResult = await supabase.from("drills").update(patch).eq("id", id).select("*").maybeSingle();
    if (updateResult.error) {
      res.status(500).json({ error: "update_failed", detail: safeMsg(updateResult.error.message) });
      return;
    }
    if (!isDrillRow(updateResult.data)) {
      res.status(500).json({ error: "update_failed" });
      return;
    }

    await logAdminAction({
      kind: "drill_updated",
      userId: uid || null,
      drillId: String(id),
      from: currentState,
      to: nextState || currentState,
      note: changelog || null,
    });

    res.status(200).json({ ok: true, drill: updateResult.data });
  } catch (error) {
    console.error("[admin/drills/item-update] error", error);
    res.status(500).json({ error: "internal_error" });
  }
};

export default router;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function resolveRequestUserId(req: ItemUpdateRequest): string {
  const fromUser = typeof req.user?.id === "string" ? req.user.id : "";
  const headerValue = req.header("x-user-id");
  const fallback = typeof headerValue === "string" ? headerValue : "";
  return fromUser || fallback || "";
}

function safeString(v: unknown): string | null {
  return typeof v === "string" ? v.trim().slice(0, 10_000) : null;
}

function toArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean).slice(0, 100);
  return [];
}

function toDifficulty(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function toRuntimeSeconds(sec: unknown, min: unknown): number | null {
  const s = Number(sec);
  if (Number.isFinite(s) && s > 0) return Math.round(s);
  const m = Number(min);
  if (Number.isFinite(m) && m > 0) return Math.round(m * 60);
  return null;
}

function isPojo(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function normalizeState(s: unknown): WorkflowState | null {
  if (!s || typeof s !== "string") return null;
  const k = s.toLowerCase() as WorkflowState;
  return WORKFLOW_SET.has(k) ? k : null;
}

function hasContentChanges(patch: Record<string, unknown>): boolean {
  const ignore = new Set(["updated_at", "version"]);
  return Object.keys(patch).some((k) => !ignore.has(k));
}

function assignIfProvided<K extends keyof DrillRow>(
  patch: Record<string, unknown>,
  drill: DrillRow,
  column: K,
  value: DrillRow[K] | null | undefined,
) {
  if (value === null || value === undefined) return;
  if (column in drill) patch[column as string] = value;
}

async function isAdminUser(userId?: string): Promise<boolean> {
  if (!userId) return false;

  const allow = String(process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.includes(userId)) return true;

  try {
    const rpc = await supabase.rpc("is_admin", { p_user_id: userId }).single();
    if (!rpc.error && rpc.data === true) return true;
  } catch {
    // ignore
  }

  try {
    const prof = await supabase.from("profiles").select("is_admin").eq("user_id", userId).maybeSingle();
    if (isProfileRow(prof.data) && prof.data.is_admin) return true;
  } catch {
    // ignore
  }

  return false;
}

async function logAdminAction(input: {
  kind: string;
  userId: string | null;
  drillId: string;
  from: string;
  to: string;
  note: string | null;
}) {
  const payload: AdminLogPayload = {
    drill_id: input.drillId,
    from: input.from,
    to: input.to,
    note: input.note,
  };

  try {
    const messageRow: AdminMessageInsert = {
      user_id: input.userId,
      kind: input.kind,
      payload,
    };
    const { error } = await supabase.from("admin_messages").insert(messageRow);
    if (!error) return;
  } catch {
    // ignore
  }

  try {
    const eventRow: EventInsert = {
      name: "admin_drill_updated",
      user_id: input.userId,
      tier: "admin",
      coach_id: null,
      meta: payload,
    };
    await supabase.from("events").insert(eventRow);
  } catch {
    // ignore
  }
}

function safeMsg(msg?: string) {
  if (!msg) return "unknown_error";
  return msg.replace(/\s+/g, " ").slice(0, 200);
}

function resolveCurrentState(drill: DrillRow): WorkflowState {
  const candidate =
    (typeof drill.state === "string" && drill.state) ||
    (typeof drill.workflow_state === "string" && drill.workflow_state) ||
    "draft";
  return normalizeState(candidate) || "draft";
}

function isAllowedTransition(from: WorkflowState, to: WorkflowState): boolean {
  if (from === to) return true;
  const a = WORKFLOW_ORDER.indexOf(from);
  const b = WORKFLOW_ORDER.indexOf(to);
  if (a < 0 || b < 0) return false;

  if (to === "approved" && (from === "in_review" || from === "auto_qa" || from === "draft")) return true;
  if (to === "published" && (from === "approved" || from === "in_review")) return true;
  if (b >= a) return true;

  const allowedBack: Partial<Record<WorkflowState, Set<WorkflowState>>> = {
    auto_qa: new Set<WorkflowState>(["draft"]),
    in_review: new Set<WorkflowState>(["auto_qa", "draft"]),
    approved: new Set<WorkflowState>(["in_review"]),
    published: new Set<WorkflowState>(["approved", "in_review"]),
    deprecated: new Set<WorkflowState>(WORKFLOW_ORDER),
  };

  const set = allowedBack[from];
  return set ? set.has(to) : false;
}

function isDrillRow(value: unknown): value is DrillRow {
  return typeof value === "object" && value !== null && "id" in value;
}

function isProfileRow(value: unknown): value is ProfileRow {
  return typeof value === "object" && value !== null && "is_admin" in value;
}
