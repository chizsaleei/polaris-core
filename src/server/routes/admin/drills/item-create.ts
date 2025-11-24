// polaris-core/src/server/routes/admin/drills/item-create.ts
import type { Request, Response } from "express";
import { Router } from "express";
import { createClient } from "../../../../lib/supabase";

const router = Router();
const supabase = createClient();

type ItemCreateBody = {
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
  changelog?: string;
  initialState?: string;
  isPublic?: boolean;
};

type ItemCreateRequest = Request<Record<string, never>, unknown, ItemCreateBody> & {
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
  state?: string | null;
  is_public?: boolean | null;
  version?: number | null;
  changelog?: string | null;
  created_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface ProfileRow extends Record<string, unknown> {
  is_admin: boolean | null;
}

type AdminLogPayload = {
  drill_id: string;
  from: string | null;
  to: string | null;
  note: string | null;
};

type AdminMessageInsert = {
  user_id: string | null;
  kind: string;
  payload: AdminLogPayload;
};

type EventInsert = {
  name: "admin_drill_created";
  user_id: string | null;
  tier: "admin";
  coach_id: string | null;
  meta: AdminLogPayload;
};

/**
 * POST /admin/drills/item-create
 *
 * Create a new drill item in the editorial workflow.
 */
router.post("/", (req: ItemCreateRequest, res: Response) => {
  void handleItemCreate(req, res);
});

const handleItemCreate = async (req: ItemCreateRequest, res: Response) => {
  try {
    const uid = resolveRequestUserId(req);
    if (!(await isAdminUser(uid))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const body = req.body ?? {};
    const title = safeString(body.title);
    if (!title) {
      res.status(400).json({ error: "missing_title" });
      return;
    }

    const type = safeString(body.type) || "speaking";
    const coachTargets = toArray(body.coachTargets);
    const skills = toArray(body.skills);
    const difficulty = toDifficulty(body.difficulty);
    const runtimeSeconds = toRuntimeSeconds(body.runtimeSeconds, body.runtimeMinutes);
    const framework = isPojo(body.framework) ? body.framework : null;
    const rubricId = body.rubricId ?? null;
    const prompt = safeString(body.prompt);
    const successCriteria = safeString(body.successCriteria);
    const nextOnFailure = safeString(body.nextOnFailure);
    const accessibilityNotes = toArray(body.accessibilityNotes);
    const altPrompt = safeString(body.altPrompt);
    const tags = toArray(body.tags);
    const changelog = safeString(body.changelog);
    const initialState = normalizeState(body.initialState) || "draft";
    const isPublic = initialState === "published" ? true : !!body.isPublic;

    const nowIso = new Date().toISOString();

    const fullPayload: Record<string, unknown> = {
      title,
      type,
      coach_targets: coachTargets.length ? coachTargets : null,
      skills: skills.length ? skills : null,
      difficulty: difficulty ?? null,
      runtime_seconds: runtimeSeconds ?? null,
      framework,
      rubric_id: rubricId,
      prompt: prompt ?? null,
      success_criteria: successCriteria ?? null,
      next_on_failure: nextOnFailure ?? null,
      accessibility_notes: accessibilityNotes.length ? accessibilityNotes : null,
      alt_prompt: altPrompt ?? null,
      tags: tags.length ? tags : null,
      state: initialState,
      is_public: isPublic,
      version: 1,
      changelog: changelog ?? null,
      created_by: uid || null,
      updated_at: nowIso,
      created_at: nowIso,
    };

    let created: DrillRow | null = null;
    let firstErrorDetail: string | null = null;

    const firstInsert = await supabase.from("drills").insert(fullPayload).select("*").maybeSingle();
    if (firstInsert.error) {
      firstErrorDetail = safeMsg(firstInsert.error.message);
    } else if (isDrillRow(firstInsert.data)) {
      created = firstInsert.data;
    }

    if (!created && firstErrorDetail) {
      const minimalPayload: Record<string, unknown> = {
        title,
        type,
        state: initialState,
        is_public: isPublic,
        created_by: uid || null,
        updated_at: nowIso,
        created_at: nowIso,
      };

      const fallbackInsert = await supabase.from("drills").insert(minimalPayload).select("*").maybeSingle();
      if (fallbackInsert.error) {
        const detail = fallbackInsert.error.message || firstErrorDetail;
        res.status(500).json({ error: "insert_failed", detail: safeMsg(detail) });
        return;
      }
      if (!isDrillRow(fallbackInsert.data)) {
        res.status(500).json({ error: "insert_failed" });
        return;
      }
      created = fallbackInsert.data;
    }

    if (!created) {
      res.status(500).json({ error: "insert_failed", detail: safeMsg(firstErrorDetail || "unknown_error") });
      return;
    }

    await logAdminAction({
      kind: "drill_created",
      userId: uid || null,
      drillId: String(created.id),
      from: null,
      to: initialState,
      note: changelog || null,
    });

    res.status(201).json({ ok: true, drill: created });
  } catch (error) {
    console.error("[admin/drills/item-create] error", error);
    res.status(500).json({ error: "internal_error" });
  }
};

export default router;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function resolveRequestUserId(req: ItemCreateRequest): string {
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

function normalizeState(s: unknown): string | null {
  if (!s || typeof s !== "string") return null;
  const k = s.toLowerCase();
  const allowed = new Set(["draft", "auto_qa", "in_review", "approved", "published", "deprecated"]);
  return allowed.has(k) ? k : null;
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
  from: string | null;
  to: string | null;
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
      name: "admin_drill_created",
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

function isDrillRow(value: unknown): value is DrillRow {
  return typeof value === "object" && value !== null && "id" in value;
}

function isProfileRow(value: unknown): value is ProfileRow {
  return typeof value === "object" && value !== null && "is_admin" in value;
}
