// polaris-core/src/server/routes/admin/drills/set-create.ts
import type { Request, Response } from "express";
import { Router } from "express";
import { createClient } from "../../../../lib/supabase";

const router = Router();
const supabase = createClient();

type WorkflowState = "draft" | "auto_qa" | "in_review" | "approved" | "published" | "deprecated";

type SetCreateBody = {
  title?: string;
  description?: string;
  tags?: unknown;
  coachTargets?: unknown;
  skills?: unknown;
  difficultyMin?: number | string;
  difficultyMax?: number | string;
  runtimeSeconds?: number | string;
  rubricId?: string | number;
  framework?: Record<string, unknown> | null;
  isPublic?: boolean;
  initialState?: string;
  changelog?: string;
  items?: unknown;
};

type SetCreateRequest = Request<Record<string, never>, unknown, SetCreateBody> & {
  user?: { id?: string | null } | null;
};

type AttachItem = { id: string | number; position?: number };

type CandidateRow = Record<string, unknown>;

type Pivot = {
  table: string;
  setCol: "set_id" | "drill_set_id";
  itemCol: "drill_id" | "item_id";
  positionCol?: "position" | "order_index";
  conflict: string;
};

const PIVOT_CANDIDATES: Pivot[] = [
  { table: "drill_set_items", setCol: "set_id", itemCol: "drill_id", positionCol: "position", conflict: "set_id,drill_id" },
  { table: "drill_items_sets", setCol: "set_id", itemCol: "item_id", positionCol: "position", conflict: "set_id,item_id" },
  { table: "drills_sets", setCol: "drill_set_id", itemCol: "drill_id", positionCol: "order_index", conflict: "drill_set_id,drill_id" },
];

type AdminLogPayload = {
  set_id: string;
  note: string | null;
  meta: Record<string, unknown> | null;
};

type AdminMessageInsert = {
  user_id: string | null;
  kind: string;
  payload: AdminLogPayload;
};

type EventInsert = {
  name: string;
  user_id: string | null;
  tier: "admin";
  coach_id: string | null;
  meta: AdminLogPayload;
};

router.post("/", (req: SetCreateRequest, res: Response) => {
  void handleSetCreate(req, res);
});

const handleSetCreate = async (req: SetCreateRequest, res: Response) => {
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

    const table = await chooseSetTable();
    if (!table) {
      res.status(500).json({ error: "sets_table_not_found" });
      return;
    }

    const nowIso = new Date().toISOString();
    const description = safeString(body.description);
    const tags = toArray(body.tags);
    const coachTargets = toArray(body.coachTargets);
    const skills = toArray(body.skills);
    const difficultyMin = toInt(body.difficultyMin);
    const difficultyMax = toInt(body.difficultyMax);
    const runtimeSeconds = toInt(body.runtimeSeconds);
    const rubricId = resolveOptionalId(body.rubricId);
    const framework = isPojo(body.framework) ? body.framework : null;
    const isPublic = typeof body.isPublic === "boolean" ? body.isPublic : false;
    const initialState = normalizeState(body.initialState) || "draft";
    const changelogIn = safeString(body.changelog);
    const changelogEntry = `[${nowIso}] ${uid || "admin"} • CREATE: ${changelogIn || title}`;

    const candidates: CandidateRow[] = buildCandidateRows({
      title,
      description,
      tags,
      coachTargets,
      skills,
      difficultyMin,
      difficultyMax,
      runtimeSeconds,
      rubricId,
      framework,
      isPublic,
      initialState,
      changelogEntry,
      uid,
      nowIso,
    });

    let created: Record<string, unknown> | null = null;
    let lastError: string | null = null;

    for (const row of candidates) {
      const result = await supabase.from(table).insert(row).select("*").maybeSingle();
      if (!result.error && result.data) {
        created = result.data as Record<string, unknown>;
        break;
      }
      lastError = safeMsg(result.error?.message);
    }

    if (!created) {
      res.status(500).json({ error: "create_failed", detail: lastError });
      return;
    }

    const setId = extractSetId(created);
    if (setId == null) {
      res.status(500).json({ error: "id_not_returned" });
      return;
    }

    const items = normalizeItems(body.items);
    let attachResult: { attached: number; errors: string[] } | undefined;

    if (items.length) {
      const pivot = await choosePivot();
      if (pivot) {
        attachResult = await tryAttachBatch(pivot, setId, items, uid, nowIso);
      }
    }

    await logAdminAction({
      kind: "drill_set_create",
      userId: uid || null,
      setId: String(setId),
      note: changelogIn || null,
      meta: { table, attached: attachResult?.attached ?? 0 },
    });

    res.status(201).json({ ok: true, set: created, attachResult });
  } catch (error) {
    console.error("[admin/drills/set-create] error", error);
    res.status(500).json({ error: "internal_error" });
  }
};

export default router;

// -----------------------------------------------------------------------------
// Table discovery
// -----------------------------------------------------------------------------

async function chooseSetTable(): Promise<string | null> {
  const candidates = ["drill_sets", "drills_sets", "content_sets", "sets"];
  for (const table of candidates) {
    try {
      const { error } = await supabase.from(table).select("*", { count: "exact", head: true }).limit(0);
      if (!error) return table;
    } catch {
      // continue
    }
  }
  return null;
}

async function choosePivot(): Promise<Pivot | null> {
  for (const pivot of PIVOT_CANDIDATES) {
    try {
      const { error } = await supabase.from(pivot.table).select("*", { count: "exact", head: true }).limit(0);
      if (!error) return pivot;
    } catch {
      // ignore
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Attach operations
// -----------------------------------------------------------------------------

async function tryAttachBatch(
  pivot: Pivot,
  setId: string | number,
  items: AttachItem[],
  uid: string | undefined,
  nowIso: string,
) {
  const rows = items.map((item, index) => {
    const row: Record<string, unknown> = {
      [pivot.setCol]: setId,
      [pivot.itemCol]: item.id,
    };
    const position = item.position ?? index + 1;
    if (pivot.positionCol) row[pivot.positionCol] = position;
    row.created_at = nowIso;
    row.updated_at = nowIso;
    row.created_by = uid || null;
    return row;
  });

  const { data, error } = await supabase.from(pivot.table).upsert(rows, { onConflict: pivot.conflict }).select(pivot.itemCol);
  const attached = Array.isArray(data) ? data.length : 0;
  return { attached, errors: error ? [safeMsg(error.message)] : [] as string[] };
}

// -----------------------------------------------------------------------------
// Admin auth and audit
// -----------------------------------------------------------------------------

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
  setId: string;
  note: string | null;
  meta?: Record<string, unknown>;
}) {
  const payload: AdminLogPayload = { set_id: input.setId, note: input.note, meta: input.meta ?? null };

  try {
    const messageRow: AdminMessageInsert = { user_id: input.userId, kind: input.kind, payload };
    const { error } = await supabase.from("admin_messages").insert(messageRow);
    if (!error) return;
  } catch {
    // ignore
  }

  try {
    const eventRow: EventInsert = {
      name: input.kind,
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

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------

function resolveRequestUserId(req: SetCreateRequest): string {
  const fromUser = typeof req.user?.id === "string" ? req.user.id : "";
  const headerValue = req.header("x-user-id");
  const fallback = typeof headerValue === "string" ? headerValue : "";
  return fromUser || fallback || "";
}

function safeString(value: unknown, limit = 10_000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, limit);
}

function toArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry)).filter(Boolean).slice(0, 100);
}

function toInt(value: unknown): number | null {
  const n = Number(value);
  if (Number.isFinite(n)) return Math.round(n);
  return null;
}

function isPojo(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeState(value: unknown): WorkflowState | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase() as WorkflowState;
  const allowed: Set<WorkflowState> = new Set(["draft", "auto_qa", "in_review", "approved", "published", "deprecated"]);
  return allowed.has(normalized) ? normalized : null;
}

function normalizeItems(value: unknown): AttachItem[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeItem(item))
      .filter((item): item is AttachItem => item !== null);
  }
  const single = normalizeItem(value);
  return single ? [single] : [];
}

function normalizeItem(value: unknown): AttachItem | null {
  if (typeof value === "number" && Number.isFinite(value)) return { id: value };
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? { id: trimmed } : null;
  }
  if (value && typeof value === "object" && "id" in value) {
    const idValue = (value as { id?: unknown }).id;
    const position = toPosition((value as { position?: unknown }).position);
    if (typeof idValue === "string") {
      const trimmed = idValue.trim();
      if (!trimmed) return null;
      return position != null ? { id: trimmed, position } : { id: trimmed };
    }
    if (typeof idValue === "number" && Number.isFinite(idValue)) {
      return position != null ? { id: idValue, position } : { id: idValue };
    }
  }
  return null;
}

function toPosition(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function resolveOptionalId(value: unknown): string | number | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function safeMsg(msg?: string) {
  if (!msg) return "unknown_error";
  return msg.replace(/\s+/g, " ").slice(0, 200);
}

function isProfileRow(value: unknown): value is { is_admin: boolean | null } {
  return typeof value === "object" && value !== null && "is_admin" in value;
}

function buildCandidateRows(input: {
  title: string;
  description: string | null;
  tags: string[];
  coachTargets: string[];
  skills: string[];
  difficultyMin: number | null;
  difficultyMax: number | null;
  runtimeSeconds: number | null;
  rubricId: string | number | null;
  framework: Record<string, unknown> | null;
  isPublic: boolean;
  initialState: WorkflowState;
  changelogEntry: string;
  uid: string | undefined;
  nowIso: string;
}): CandidateRow[] {
  const base = {
    title: input.title,
    description: input.description ?? null,
    tags: input.tags.length ? input.tags : null,
    coach_targets: input.coachTargets.length ? input.coachTargets : null,
    skills: input.skills.length ? input.skills : null,
    difficulty_min: input.difficultyMin ?? null,
    difficulty_max: input.difficultyMax ?? null,
    runtime_seconds: input.runtimeSeconds ?? null,
    rubric_id: input.rubricId ?? null,
    framework: input.framework,
    is_public: input.isPublic,
    version: 1,
    changelog: input.changelogEntry,
    created_by: input.uid || null,
    created_at: input.nowIso,
    updated_at: input.nowIso,
  };

  const candidates: CandidateRow[] = [];
  candidates.push({ ...base, state: input.initialState });
  candidates.push({ ...base, workflow_state: input.initialState });
  candidates.push({
    title: input.title,
    is_public: input.isPublic,
    created_by: input.uid || null,
    created_at: input.nowIso,
    updated_at: input.nowIso,
  });
  return candidates;
}

function extractSetId(row: Record<string, unknown>): string | number | null {
  const candidates = ["id", "set_id", "drill_set_id"];
  for (const key of candidates) {
    const value = row[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}
