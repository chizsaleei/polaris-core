// polaris-core/src/server/routes/admin/messages.ts
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { createClient } from "../../../lib/supabase";
import {
  type AdminMessageCreateInput,
  type AdminMessageCreateResponse,
  type AdminMessageImportance,
  type AdminMessageItemResponse,
  type AdminMessageListResponse,
  type AdminMessageQueueResponse,
  type AdminMessageRow,
  type AdminMessageState,
  type AdminMessageUpdateInput,
  type JSONArray,
  type JSONObject,
  type JSONValue,
} from "../../../types";

const router = Router();
const supabase = createClient();

// ---------------------------------------------------------------------------
// Shared types that UI can also import via the shared types package
// ---------------------------------------------------------------------------

type ErrorResponse = { error: string };

const ADMIN_MESSAGE_COLUMNS =
  "id,author_id,title,body_text,body_html,importance,tags,hero_image_url,cta_label,cta_url,audience_filter,state,send_at,sent_at,canceled_at,created_at,updated_at,meta";

const ADMIN_STATES: readonly AdminMessageState[] = [
  "draft",
  "approved",
  "scheduled",
  "sending",
  "sent",
  "canceled",
  "archived",
];

const ADMIN_IMPORTANCES: readonly AdminMessageImportance[] = [
  "low",
  "normal",
  "high",
  "urgent",
];

interface AdminProfileRow {
  is_admin: boolean | null;
}

interface AuthedUser {
  id?: string;
}

type AdminRequest = Request<ParamsDictionary>;
type AuthedRequest = Request<ParamsDictionary> & {
  user?: AuthedUser;
};

type MessageStateRow = Pick<AdminMessageRow, "id" | "state" | "send_at">;
type MessageStateOnlyRow = Pick<AdminMessageRow, "id" | "state">;

type AdminMessageInsert = Pick<
  AdminMessageRow,
  | "author_id"
  | "title"
  | "body_text"
  | "body_html"
  | "importance"
  | "tags"
  | "hero_image_url"
  | "cta_label"
  | "cta_url"
  | "audience_filter"
  | "state"
  | "send_at"
  | "meta"
>;

type AdminMessageUpdatePatch = Partial<
  Pick<
    AdminMessageRow,
    | "title"
    | "body_text"
    | "body_html"
    | "importance"
    | "tags"
    | "hero_image_url"
    | "cta_label"
    | "cta_url"
    | "audience_filter"
    | "state"
    | "send_at"
    | "meta"
  >
>;

// ---------------------------------------------------------------------------
// Admin guard (allow list -> RPC -> profiles.is_admin)
// ---------------------------------------------------------------------------

async function isAdminUser(userId?: string | null): Promise<boolean> {
  if (!userId) return false;

  const allow = String(process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.includes(userId)) return true;

  try {
    const rpc = await supabase.rpc("is_admin", { p_user_id: userId }).single();
    if (!rpc.error) {
      if (rpc.data === true) return true;
      const adminRow = asProfileAdminRow(rpc.data);
      if (adminRow?.is_admin) return true;
    }
  } catch {
    // ignore
  }

  try {
    const prof = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("user_id", userId)
      .maybeSingle();
    const adminRow = asProfileAdminRow(prof.data);
    if (adminRow?.is_admin) return true;
  } catch {
    // ignore
  }

  return false;
}

router.use((req, res, next) => {
  void adminGuard(req as AuthedRequest, res, next);
});

async function adminGuard(
  req: AuthedRequest,
  res: Response<ErrorResponse>,
  next: NextFunction,
): Promise<void> {
  try {
    const headerUserId = req.header("x-user-id");
    const sanitizedHeader =
      typeof headerUserId === "string" ? headerUserId.trim() : "";
    const uid = req.user?.id ?? (sanitizedHeader || null);

    if (!(await isAdminUser(uid))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  } catch (e: unknown) {
    console.error("[admin/messages] guard error", e);
    res.status(500).json({ error: "internal_error" });
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function sanitizeError(msg: string): string {
  return msg.replace(/\s+/g, " ").slice(0, 180);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown): JSONValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value as JSONValue;
  }

  if (Array.isArray(value)) {
    const arr: JSONArray = value.map((v) => toJsonValue(v)) as JSONArray;
    return arr;
  }

  if (isRecord(value)) {
    const obj: JSONObject = {};
    for (const [k, v] of Object.entries(value)) {
      obj[k] = toJsonValue(v);
    }
    return obj;
  }

  return null;
}

function toJsonObject(value: unknown): JSONObject {
  const v = toJsonValue(value);
  return isJsonObject(v) ? v : {};
}

function isJsonObject(value: JSONValue): value is JSONObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parseTags(v: unknown): string[] {
  const normalize = (value: unknown): string | null => {
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value.toString(10);
    }
    return null;
  };

  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const entry of v) {
      const raw = normalize(entry);
      if (!raw) continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      out.push(trimmed);
    }
    return out;
  }
  if (typeof v === "string") {
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeState(raw: unknown): AdminMessageState {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  return ADMIN_STATES.includes(s as AdminMessageState)
    ? (s as AdminMessageState)
    : "draft";
}

function normalizeStateForFilter(
  raw: unknown,
): AdminMessageState | undefined {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  return ADMIN_STATES.includes(s as AdminMessageState)
    ? (s as AdminMessageState)
    : undefined;
}

function normalizeImportance(raw: unknown): AdminMessageImportance {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  return ADMIN_IMPORTANCES.includes(s as AdminMessageImportance)
    ? (s as AdminMessageImportance)
    : "normal";
}

function normalizeImportanceForFilter(
  raw: unknown,
): AdminMessageImportance | undefined {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  return ADMIN_IMPORTANCES.includes(s as AdminMessageImportance)
    ? (s as AdminMessageImportance)
    : undefined;
}

function isoOrNull(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const d = new Date(raw);
  return Number.isFinite(d.valueOf()) ? d.toISOString() : null;
}

function pickQueryString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

function asAdminMessageRow(value: unknown): AdminMessageRow | null {
  if (!isRecord(value)) return null;
  const {
    id,
    author_id: authorId,
    title,
    body_text: bodyTextRaw,
    body_html: bodyHtmlRaw,
    importance,
    tags: tagsRaw,
    hero_image_url: heroImageUrlRaw,
    cta_label: ctaLabelRaw,
    cta_url: ctaUrlRaw,
    audience_filter: audienceFilterRaw,
    state,
    send_at: sendAtRaw,
    sent_at: sentAtRaw,
    canceled_at: canceledAtRaw,
    created_at: createdAt,
    updated_at: updatedAt,
    meta: metaRaw,
  } = value;

  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }

  const tags = isStringArray(tagsRaw) ? tagsRaw : [];

  return {
    id,
    author_id: typeof authorId === "string" ? authorId : null,
    title,
    body_text: typeof bodyTextRaw === "string" ? bodyTextRaw : null,
    body_html: typeof bodyHtmlRaw === "string" ? bodyHtmlRaw : null,
    importance: normalizeImportance(importance),
    tags,
    hero_image_url:
      typeof heroImageUrlRaw === "string" ? heroImageUrlRaw : null,
    cta_label: typeof ctaLabelRaw === "string" ? ctaLabelRaw : null,
    cta_url: typeof ctaUrlRaw === "string" ? ctaUrlRaw : null,
    audience_filter: toJsonObject(audienceFilterRaw),
    state: normalizeState(state),
    send_at: typeof sendAtRaw === "string" ? sendAtRaw : null,
    sent_at: typeof sentAtRaw === "string" ? sentAtRaw : null,
    canceled_at: typeof canceledAtRaw === "string" ? canceledAtRaw : null,
    created_at: createdAt,
    updated_at: updatedAt,
    meta: toJsonObject(metaRaw),
  };
}

function asAdminMessageRows(value: unknown): AdminMessageRow[] {
  if (!Array.isArray(value)) return [];
  const rows: AdminMessageRow[] = [];
  for (const entry of value) {
    const row = asAdminMessageRow(entry);
    if (row) rows.push(row);
  }
  return rows;
}

function asMessageStateRow(value: unknown): MessageStateRow | null {
  if (!isRecord(value)) return null;
  const { id, state, send_at: sendAt } = value;
  if (typeof id !== "string") return null;
  if (typeof state !== "string") return null;
  if (sendAt !== null && typeof sendAt !== "string") return null;
  return {
    id,
    state: state as AdminMessageState,
    send_at: typeof sendAt === "string" ? sendAt : null,
  };
}

function asMessageStateOnlyRow(
  value: unknown,
): MessageStateOnlyRow | null {
  if (!isRecord(value)) return null;
  const { id, state } = value;
  if (typeof id !== "string") return null;
  if (typeof state !== "string") return null;
  return { id, state: state as AdminMessageState };
}

function asProfileAdminRow(value: unknown): AdminProfileRow | null {
  if (!isRecord(value)) return null;
  const { is_admin: isAdmin } = value;
  if (isAdmin === null || typeof isAdmin === "boolean") {
    return { is_admin: isAdmin ?? null };
  }
  return null;
}

function sanitizeCreateBody(
  input: unknown,
  authorId: string | null,
): AdminMessageInsert {
  const b: Partial<AdminMessageCreateInput> = isRecord(input)
    ? (input as Partial<AdminMessageCreateInput>)
    : {};

  const title =
    typeof b.title === "string" ? b.title.trim().slice(0, 280) : "";
  const bodyText =
    typeof b.bodyText === "string" ? b.bodyText : null;
  const bodyHtml =
    typeof b.bodyHtml === "string" ? b.bodyHtml : null;
  const tags = parseTags(b.tags);
  const sendAt = isoOrNull(b.sendAt);

  const heroImageUrl =
    typeof b.heroImageUrl === "string" ? b.heroImageUrl : null;
  const ctaLabel =
    typeof b.ctaLabel === "string" ? b.ctaLabel : null;
  const ctaUrl = typeof b.ctaUrl === "string" ? b.ctaUrl : null;

  const state = normalizeState(b.state);
  const importance = normalizeImportance(b.importance);
  const audienceFilter = toJsonObject(b.audienceFilter);
  const meta = toJsonObject(b.meta);

  return {
    author_id: authorId,
    title,
    body_text: bodyText,
    body_html: bodyHtml,
    importance,
    tags,
    hero_image_url: heroImageUrl,
    cta_label: ctaLabel,
    cta_url: ctaUrl,
    audience_filter: audienceFilter,
    state,
    send_at: sendAt,
    meta,
  };
}

function buildUpdatePatch(
  input: unknown,
): AdminMessageUpdatePatch {
  const b: Partial<AdminMessageUpdateInput> = isRecord(input)
    ? (input as Partial<AdminMessageUpdateInput>)
    : {};
  const patch: AdminMessageUpdatePatch = {};

  if (typeof b.title === "string") {
    patch.title = b.title.trim().slice(0, 280);
  }
  if (typeof b.bodyText === "string" || b.bodyText === null) {
    patch.body_text = b.bodyText ?? null;
  }
  if (typeof b.bodyHtml === "string" || b.bodyHtml === null) {
    patch.body_html = b.bodyHtml ?? null;
  }
  if (typeof b.importance === "string") {
    patch.importance = normalizeImportance(b.importance);
  }
  if (typeof b.state === "string") {
    patch.state = normalizeState(b.state);
  }
  if (typeof b.heroImageUrl !== "undefined") {
    patch.hero_image_url = b.heroImageUrl ?? null;
  }
  if (typeof b.ctaLabel !== "undefined") {
    patch.cta_label = b.ctaLabel ?? null;
  }
  if (typeof b.ctaUrl !== "undefined") {
    patch.cta_url = b.ctaUrl ?? null;
  }
  if (typeof b.sendAt !== "undefined") {
    patch.send_at = isoOrNull(b.sendAt);
  }
  if (typeof b.tags !== "undefined") {
    patch.tags = parseTags(b.tags);
  }
  if (typeof b.audienceFilter !== "undefined") {
    patch.audience_filter = toJsonObject(b.audienceFilter);
  }
  if (typeof b.meta !== "undefined") {
    patch.meta = toJsonObject(b.meta);
  }

  return patch;
}

// ---------------------------------------------------------------------------
// GET /admin/messages
// Query params: state, importance, tag, authorId, q, limit, offset
// ---------------------------------------------------------------------------

router.get("/", (req, res) => {
  void handleListMessages(req as AdminRequest, res);
});

async function handleListMessages(
  req: AdminRequest,
  res: Response<AdminMessageListResponse | ErrorResponse>,
): Promise<void> {
  try {
    const stateFilter = normalizeStateForFilter(
      pickQueryString(req.query.state as unknown),
    );
    const importanceFilter = normalizeImportanceForFilter(
      pickQueryString(req.query.importance as unknown),
    );
    const tag = pickQueryString(req.query.tag as unknown);
    const authorId = pickQueryString(req.query.authorId as unknown);
    const q = pickQueryString(req.query.q as unknown);

    const limitRaw = pickQueryString(req.query.limit as unknown);
    const offsetRaw = pickQueryString(req.query.offset as unknown);
    const limit = Math.min(
      Number.parseInt(limitRaw || "50", 10) || 50,
      200,
    );
    const offset = Number.parseInt(offsetRaw || "0", 10) || 0;

    let qbuilder = supabase
      .from("admin_messages")
      .select(ADMIN_MESSAGE_COLUMNS)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (stateFilter) {
      qbuilder = qbuilder.eq("state", stateFilter);
    }
    if (importanceFilter) {
      qbuilder = qbuilder.eq("importance", importanceFilter);
    }
    if (authorId) {
      qbuilder = qbuilder.eq("author_id", authorId);
    }
    if (tag) {
      qbuilder = qbuilder.contains("tags", [tag]);
    }
    if (q) {
      qbuilder = qbuilder.or(
        `title.ilike.%${q}%,body_text.ilike.%${q}%`,
      );
    }

    const { data, error } = await qbuilder;
    if (error) {
      res.status(400).json({ error: sanitizeError(error.message) });
      return;
    }
    const items = asAdminMessageRows(data);
    res.status(200).json({ ok: true, items });
  } catch (e: unknown) {
    console.error("[admin/messages:list]", e);
    res.status(500).json({ error: "internal_error" });
  }
}

// ---------------------------------------------------------------------------
// GET /admin/messages/:id
// ---------------------------------------------------------------------------

router.get("/:id", (req, res) => {
  void handleGetMessage(req as AdminRequest, res);
});

async function handleGetMessage(
  req: AdminRequest,
  res: Response<AdminMessageItemResponse | ErrorResponse>,
): Promise<void> {
  try {
    const id = String(req.params.id);
    const sel = await supabase
      .from("admin_messages")
      .select(ADMIN_MESSAGE_COLUMNS)
      .eq("id", id)
      .maybeSingle();

    if (sel.error) {
      res
        .status(400)
        .json({ error: sanitizeError(sel.error.message) });
      return;
    }
    const item = asAdminMessageRow(sel.data);
    if (!item) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.status(200).json({ ok: true, item });
  } catch (e: unknown) {
    console.error("[admin/messages:get]", e);
    res.status(500).json({ error: "internal_error" });
  }
}

// ---------------------------------------------------------------------------
// POST /admin/messages
// Body: AdminMessageCreateInput
// ---------------------------------------------------------------------------

router.post("/", (req, res) => {
  void handleCreateMessage(req as AuthedRequest, res);
});

async function handleCreateMessage(
  req: AuthedRequest,
  res: Response<AdminMessageCreateResponse | ErrorResponse>,
): Promise<void> {
  try {
    const headerUserId = req.header("x-user-id");
    const sanitizedHeader =
      typeof headerUserId === "string" ? headerUserId.trim() : "";
    const authorId = req.user?.id ?? (sanitizedHeader || null);
    const rawBody: unknown = req.body;
    const payload = sanitizeCreateBody(rawBody, authorId);

    if (!payload.title) {
      res.status(400).json({ error: "title_required" });
      return;
    }
    if (!payload.body_text && !payload.body_html) {
      res.status(400).json({ error: "body_required" });
      return;
    }

    const ins = await supabase
      .from("admin_messages")
      .insert(payload)
      .select("id")
      .single();
    if (ins.error) {
      res
        .status(400)
        .json({ error: sanitizeError(ins.error.message) });
      return;
    }
    const createdId =
      ins.data && typeof ins.data.id === "string" ? ins.data.id : null;
    if (!createdId) {
      res.status(500).json({ error: "internal_error" });
      return;
    }
    res.status(201).json({ ok: true, id: createdId });
  } catch (e: unknown) {
    console.error("[admin/messages:create]", e);
    res.status(500).json({ error: "internal_error" });
  }
}

// ---------------------------------------------------------------------------
// PATCH /admin/messages/:id
// Body supports partial update: AdminMessageUpdateInput
// ---------------------------------------------------------------------------

router.patch("/:id", (req, res) => {
  void handleUpdateMessage(req as AdminRequest, res);
});

async function handleUpdateMessage(
  req: AdminRequest,
  res: Response<{ ok: true } | ErrorResponse>,
): Promise<void> {
  try {
    const id = String(req.params.id);
    const rawBody: unknown = req.body;
    const patch = buildUpdatePatch(rawBody);

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "nothing_to_update" });
      return;
    }

    const upd = await supabase
      .from("admin_messages")
      .update(patch)
      .eq("id", id)
      .select("id")
      .single();
    if (upd.error) {
      res
        .status(400)
        .json({ error: sanitizeError(upd.error.message) });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (e: unknown) {
    console.error("[admin/messages:update]", e);
    res.status(500).json({ error: "internal_error" });
  }
}

// ---------------------------------------------------------------------------
// POST /admin/messages/:id/queue
// Sets state to 'scheduled'. If no send_at, sets to now.
// ---------------------------------------------------------------------------

router.post("/:id/queue", (req, res) => {
  void handleQueueMessage(req as AdminRequest, res);
});

async function handleQueueMessage(
  req: AdminRequest,
  res: Response<AdminMessageQueueResponse | ErrorResponse>,
): Promise<void> {
  try {
    const id = String(req.params.id);
    const current = await supabase
      .from("admin_messages")
      .select("id,state,send_at")
      .eq("id", id)
      .maybeSingle();

    if (current.error) {
      res
        .status(400)
        .json({ error: sanitizeError(current.error.message) });
      return;
    }
    const currentData = asMessageStateRow(current.data);
    if (!currentData) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (currentData.state === "sent" || currentData.state === "archived") {
      res.status(409).json({ error: "cannot_queue_in_this_state" });
      return;
    }

    const nowIso = new Date().toISOString();
    const sendAt = currentData.send_at || nowIso;

    const upd = await supabase
      .from("admin_messages")
      .update({ state: "scheduled", send_at: sendAt })
      .eq("id", id)
      .select("id,state,send_at")
      .single();

    if (upd.error) {
      res
        .status(400)
        .json({ error: sanitizeError(upd.error.message) });
      return;
    }

    const item = asMessageStateRow(upd.data);
    if (!item) {
      res.status(500).json({ error: "internal_error" });
      return;
    }
    res.status(202).json({ ok: true, item });
  } catch (e: unknown) {
    console.error("[admin/messages:queue]", e);
    res.status(500).json({ error: "internal_error" });
  }
}

// ---------------------------------------------------------------------------
// POST /admin/messages/:id/cancel
// Moves scheduled/sending back to canceled.
// ---------------------------------------------------------------------------

router.post("/:id/cancel", (req, res) => {
  void handleCancelMessage(req as AdminRequest, res);
});

async function handleCancelMessage(
  req: AdminRequest,
  res: Response<AdminMessageItemResponse | ErrorResponse>,
): Promise<void> {
  try {
    const id = String(req.params.id);
    const msg = await supabase
      .from("admin_messages")
      .select("id,state")
      .eq("id", id)
      .maybeSingle();

    if (msg.error) {
      res
        .status(400)
        .json({ error: sanitizeError(msg.error.message) });
      return;
    }
    const msgData = asMessageStateOnlyRow(msg.data);
    if (!msgData) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (msgData.state === "sent" || msgData.state === "archived") {
      res.status(409).json({ error: "cannot_cancel_in_this_state" });
      return;
    }

    const nowIso = new Date().toISOString();
    const upd = await supabase
      .from("admin_messages")
      .update({ state: "canceled", canceled_at: nowIso, send_at: null })
      .eq("id", id)
      .select(ADMIN_MESSAGE_COLUMNS)
      .single();

    if (upd.error) {
      res
        .status(400)
        .json({ error: sanitizeError(upd.error.message) });
      return;
    }

    const item = asAdminMessageRow(upd.data);
    if (!item) {
      res.status(500).json({ error: "internal_error" });
      return;
    }

    res.status(200).json({ ok: true, item });
  } catch (e: unknown) {
    console.error("[admin/messages:cancel]", e);
    res.status(500).json({ error: "internal_error" });
  }
}

// ---------------------------------------------------------------------------
// DELETE /admin/messages/:id
// Allows delete only for draft or canceled.
// ---------------------------------------------------------------------------

router.delete("/:id", (req, res) => {
  void handleDeleteMessage(req as AdminRequest, res);
});

async function handleDeleteMessage(
  req: AdminRequest,
  res: Response<{ ok: true } | ErrorResponse>,
): Promise<void> {
  try {
    const id = String(req.params.id);
    const cur = await supabase
      .from("admin_messages")
      .select("id,state")
      .eq("id", id)
      .maybeSingle();

    if (cur.error) {
      res
        .status(400)
        .json({ error: sanitizeError(cur.error.message) });
      return;
    }
    const curData = asMessageStateOnlyRow(cur.data);
    if (!curData) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (curData.state !== "draft" && curData.state !== "canceled") {
      res
        .status(409)
        .json({ error: "only_draft_or_canceled_can_be_deleted" });
      return;
    }

    const del = await supabase
      .from("admin_messages")
      .delete()
      .eq("id", id);
    if (del.error) {
      res
        .status(400)
        .json({ error: sanitizeError(del.error.message) });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (e: unknown) {
    console.error("[admin/messages:delete]", e);
    res.status(500).json({ error: "internal_error" });
  }
}

export default router;
