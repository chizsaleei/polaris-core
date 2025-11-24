// polaris-core/src/server/routes/admin/drills/topic-create.ts
import type { Request, Response } from "express";
import { Router } from "express";
import type { PostgrestError } from "@supabase/supabase-js";
import type { ParamsDictionary } from "express-serve-static-core";
import { createClient } from "../../../../lib/supabase";

const router = Router();
const supabase = createClient();

interface TopicCreateBody {
  title?: string;
  slug?: string;
  description?: string;
  tags?: unknown;
  coachTargets?: unknown;
  skills?: unknown;
  difficultyMin?: unknown;
  difficultyMax?: unknown;
  rubricId?: unknown;
  framework?: unknown;
  isPublic?: boolean;
  initialState?: string;
  changelog?: string;
}

type TopicCreateRequest = Request<ParamsDictionary, unknown, TopicCreateBody> & { user?: { id?: string | null } };

interface TopicRow {
  [key: string]: unknown;
}

type TopicPatch = Record<string, unknown>;

/**
 * POST /admin/drills/topic-create
 *
 * Create or upsert a drill topic. Supports flexible schemas.
 */

router.post("/", (req: Request, res: Response) => {
  void handleTopicCreate(req as TopicCreateRequest, res);
});

const handleTopicCreate = async (req: TopicCreateRequest, res: Response): Promise<void> => {
  try {
    const uid = readUserId(req.user?.id) ?? readUserId(req.header("x-user-id"));
    if (!(await isAdminUser(uid))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const body = isTopicCreateBody(req.body) ? req.body : {};
    const title = safeString(body.title);
    if (!title) {
      res.status(400).json({ error: "missing_title" });
      return;
    }

    const nowIso = new Date().toISOString();
    const description = safeString(body.description);
    const desiredSlug = safeString(body.slug) || toSlug(title);
    const tags = toArray(body.tags);
    const coachTargets = toArray(body.coachTargets);
    const skills = toArray(body.skills);
    const difficultyMin = toInt(body.difficultyMin);
    const difficultyMax = toInt(body.difficultyMax);
    const rubricId =
      typeof body.rubricId === "string" || typeof body.rubricId === "number" ? String(body.rubricId) : undefined;
    const framework = isPojo(body.framework) ? body.framework : undefined;
    const isPublic = typeof body.isPublic === "boolean" ? body.isPublic : undefined;
    const initialState = normalizeState(body.initialState) || "draft";
    const changelogIn = safeString(body.changelog);
    const changelogEntry = `[${nowIso}] ${uid || "admin"} • CREATE TOPIC: ${changelogIn || title}`;

    const table = await chooseTopicTable();
    if (!table) {
      res.status(500).json({ error: "topics_table_not_found" });
      return;
    }
    const idCol = await findIdColumn(table);
    if (!idCol) {
      res.status(500).json({ error: "id_column_not_found" });
      return;
    }
    const slugCol = await findSlugColumn(table);

    const slug = slugCol ? await ensureUniqueSlug(table, slugCol, desiredSlug) : null;

    const candidates: TopicPatch[] = [
      {
        title,
        [slugCol || "slug"]: slug ?? undefined,
        description: description ?? null,
        tags: tags.length ? tags : null,
        coach_targets: coachTargets.length ? coachTargets : null,
        skills: skills.length ? skills : null,
        difficulty_min: difficultyMin ?? null,
        difficulty_max: difficultyMax ?? null,
        rubric_id: rubricId ?? null,
        framework: framework ?? null,
        state: initialState,
        is_public: isPublic ?? false,
        version: 1,
        changelog: changelogEntry,
        created_by: uid || null,
        created_at: nowIso,
        updated_at: nowIso,
      },
      {
        title,
        [slugCol || "slug"]: slug ?? undefined,
        description: description ?? null,
        tags: tags.length ? tags : null,
        coach_targets: coachTargets.length ? coachTargets : null,
        skills: skills.length ? skills : null,
        difficulty_min: difficultyMin ?? null,
        difficulty_max: difficultyMax ?? null,
        rubric_id: rubricId ?? null,
        framework: framework ?? null,
        workflow_state: initialState,
        is_public: isPublic ?? false,
        version: 1,
        changelog: changelogEntry,
        created_by: uid || null,
        created_at: nowIso,
        updated_at: nowIso,
      },
      {
        title,
        [slugCol || "slug"]: slug ?? undefined,
        description: description ?? null,
        is_public: isPublic ?? false,
        created_by: uid || null,
        created_at: nowIso,
        updated_at: nowIso,
      },
    ];

    let created: TopicRow | null = null;
    let lastErr: PostgrestError | null = null;

    for (const row of candidates) {
      const insertResult = await supabase
        .from(table)
        .insert(row)
        .select("*")
        .maybeSingle<Record<string, unknown>>();
      const data = insertResult.data;
      const error = insertResult.error;
      if (!error && data) {
        created = data;
        break;
      }
      lastErr = error;
    }

    if (!created) {
      res.status(500).json({ error: "create_failed", detail: safeMsg(lastErr?.message) });
      return;
    }

    const pivot = await chooseTopicCoachPivot();
    const createdIdValue = created[idCol];
    if (typeof createdIdValue !== "string" && typeof createdIdValue !== "number") {
      res.status(500).json({ error: "invalid_topic_id" });
      return;
    }

    let attachResult: { attached: number; errors: string[] } | undefined;
    if (pivot && coachTargets.length) {
      attachResult = await attachCoachesToTopic(pivot, createdIdValue, coachTargets, uid, nowIso);
    }

    await logAdminAction({
      kind: "topic_create",
      userId: uid || null,
      topicId: String(createdIdValue),
      note: changelogIn || null,
      meta: { table, coaches_attached: attachResult?.attached ?? 0 },
    });

    res.status(201).json({ ok: true, topic: created, attachResult });
  } catch (error) {
    logError("[admin/drills/topic-create] error", error);
    res.status(500).json({ error: "internal_error" });
  }
};

export default router;

// -----------------------------------------------------------------------------
// Table discovery
// -----------------------------------------------------------------------------

async function chooseTopicTable(): Promise<string | null> {
  const candidates = ["drill_topics", "topics", "content_topics"];
  for (const t of candidates) {
    try {
      const { error } = await supabase
        .from(t)
        .select("*", { head: true, count: "exact" })
        .limit(0);
      if (!error) return t;
    } catch {
      // keep trying
    }
  }
  return null;
}

async function findIdColumn(
  table: string,
): Promise<"id" | "topic_id" | null> {
  const cols: Array<"id" | "topic_id"> = ["id", "topic_id"];
  for (const c of cols) {
    try {
      const { error } = await supabase
        .from(table)
        .select(c, { head: true, count: "exact" })
        .limit(0);
      if (!error) return c;
    } catch {
      // ignore
    }
  }
  return null;
}

async function findSlugColumn(
  table: string,
): Promise<"slug" | "key" | null> {
  const cols: Array<"slug" | "key"> = ["slug", "key"];
  for (const c of cols) {
    try {
      const { error } = await supabase
        .from(table)
        .select(c, { head: true, count: "exact" })
        .limit(0);
      if (!error) return c;
    } catch {
      // ignore
    }
  }
  return null;
}

async function ensureUniqueSlug(
  table: string,
  slugCol: "slug" | "key",
  base: string,
): Promise<string> {
  let slug = base || "topic";
  let n = 1;
  // Try up to a reasonable limit
  while (n < 100) {
    const { count } = await supabase.from(table).select(slugCol, { count: "exact" }).eq(slugCol, slug).limit(1);
    if ((count || 0) === 0) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
  // Last resort
  return `${base}-${Date.now().toString(36)}`;
}

// -----------------------------------------------------------------------------
// Coach pivot attach
// -----------------------------------------------------------------------------

type TopicCoachPivot = {
  table: string;
  topicCol: "topic_id" | "id";
  coachCol: "coach_key" | "coach" | "coach_id";
  conflict: string;
};

const PIVOT_CANDIDATES: TopicCoachPivot[] = [
  { table: "topic_coach_targets", topicCol: "topic_id", coachCol: "coach_key", conflict: "topic_id,coach_key" },
  { table: "coaches_topics", topicCol: "topic_id", coachCol: "coach_key", conflict: "topic_id,coach_key" },
  { table: "topics_coaches", topicCol: "topic_id", coachCol: "coach", conflict: "topic_id,coach" },
];

async function chooseTopicCoachPivot(): Promise<TopicCoachPivot | null> {
  for (const p of PIVOT_CANDIDATES) {
    try {
      const { error } = await supabase
        .from(p.table)
        .select("*", { head: true, count: "exact" })
        .limit(0);
      if (!error) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

async function attachCoachesToTopic(
  pivot: TopicCoachPivot,
  topicId: string | number,
  coachKeys: string[],
  uid: string | undefined,
  nowIso: string,
) {
  const rows = coachKeys.map((k) => ({
    [pivot.topicCol]: topicId,
    [pivot.coachCol]: k,
    created_by: uid || null,
    created_at: nowIso,
    updated_at: nowIso,
  }));

  const { data, error } = await supabase.from(pivot.table).upsert(rows, { onConflict: pivot.conflict }).select(
    pivot.coachCol,
  );

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
  topicId: string;
  note: string | null;
  meta?: Record<string, unknown>;
}) {
  try {
    const adminPayload = {
      user_id: input.userId,
      kind: input.kind,
      payload: {
        topic_id: input.topicId,
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
        topic_id: input.topicId,
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

function safeString(v: unknown): string | null {
  return typeof v === "string" ? v.trim().slice(0, 10_000) : null;
}
function toArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v
      .map((x) => firstString(x))
      .filter((x): x is string => Boolean(x))
      .slice(0, 100);
  }
  if (typeof v === "string") {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 100);
  }
  const single = firstString(v);
  return single ? [single] : [];
}
function toInt(v: unknown): number | undefined {
  const n = Number(v);
  if (Number.isFinite(n)) return Math.round(n);
  return undefined;
}
function isPojo(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

type TopicState = "draft" | "auto_qa" | "in_review" | "approved" | "published" | "deprecated";

function normalizeState(s: unknown): TopicState | null {
  if (!s || typeof s !== "string") return null;
  const k = s.toLowerCase();
  const allowed: TopicState[] = ["draft", "auto_qa", "in_review", "approved", "published", "deprecated"];
  return allowed.includes(k as TopicState) ? (k as TopicState) : null;
}

function toSlug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}
function safeMsg(msg?: string) {
  return String(msg || "").replace(/\s+/g, " ").slice(0, 200);
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

function readUserId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function logError(label: string, error: unknown) {
  console.error(label, error);
}

function isTopicCreateBody(value: unknown): value is TopicCreateBody {
  return Boolean(value) && typeof value === "object";
}
