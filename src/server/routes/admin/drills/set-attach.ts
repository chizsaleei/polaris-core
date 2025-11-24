// polaris-core/src/server/routes/admin/drills/set-attach.ts
import type { Request, Response } from "express";
import { Router } from "express";
import { createClient } from "../../../../lib/supabase";

const router = Router();
const supabase = createClient();

type AttachMode = "attach" | "detach" | "replace";

type SetAttachBody = {
  setId?: string | number;
  items?: unknown;
  mode?: AttachMode;
  changelog?: string;
};

type SetAttachRequest = Request<Record<string, never>, unknown, SetAttachBody> & {
  user?: { id?: string | null } | null;
};

type AttachItem = { id: string | number; position?: number };

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

/**
 * POST /admin/drills/set-attach
 *
 * Attach, detach, or replace drill items in a set.
 */
router.post("/", (req: SetAttachRequest, res: Response) => {
  void handleSetAttach(req, res);
});

const handleSetAttach = async (req: SetAttachRequest, res: Response) => {
  try {
    const uid = resolveRequestUserId(req);
    if (!(await isAdminUser(uid))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const body = req.body ?? {};
    const setId = normalizeSetId(body.setId);
    if (setId == null) {
      res.status(400).json({ error: "missing_setId" });
      return;
    }

    const mode = normalizeMode(body.mode);
    const items = normalizeItems(body.items);
    if ((mode === "attach" || mode === "replace") && items.length === 0) {
      res.status(400).json({ error: "missing_items" });
      return;
    }

    const nowIso = new Date().toISOString();
    const changeNote = safeString(body.changelog, 2_000);
    const pivot = await choosePivot();
    if (!pivot) {
      res.status(500).json({ error: "pivot_table_not_found" });
      return;
    }

    if (mode === "replace") {
      await tryDeleteAllForSet(pivot, setId);
      const { attached, errors } = await tryAttachBatch(pivot, setId, items, uid, nowIso);
      await logAdminAction({
        kind: "drill_set_replace",
        userId: uid || null,
        setId: String(setId),
        note: changeNote,
        meta: { attached, errors },
      });
      res.status(200).json({ ok: true, mode, attached, errors });
      return;
    }

    if (mode === "attach") {
      const { attached, errors } = await tryAttachBatch(pivot, setId, items, uid, nowIso);
      await logAdminAction({
        kind: "drill_set_attach",
        userId: uid || null,
        setId: String(setId),
        note: changeNote,
        meta: { attached, errors },
      });
      res.status(200).json({ ok: true, mode, attached, errors });
      return;
    }

    if (mode === "detach") {
      const ids = items.map((x) => x.id);
      const { deleted, error } = await tryDetachBatch(pivot, setId, ids);
      await logAdminAction({
        kind: "drill_set_detach",
        userId: uid || null,
        setId: String(setId),
        note: changeNote,
        meta: { deleted, error },
      });
      if (error) {
        res.status(500).json({ error: "detach_failed", detail: error });
        return;
      }
      res.status(200).json({ ok: true, mode, deleted });
      return;
    }

    res.status(400).json({ error: "unsupported_mode" });
  } catch (error) {
    console.error("[admin/drills/set-attach] error", error);
    res.status(500).json({ error: "internal_error" });
  }
};

export default router;

// -----------------------------------------------------------------------------
// Pivot helper
// -----------------------------------------------------------------------------

async function choosePivot(): Promise<Pivot | null> {
  for (const candidate of PIVOT_CANDIDATES) {
    try {
      const probe = await supabase.from(candidate.table).select("*", { count: "exact", head: true }).limit(0);
      if (!probe.error) return candidate;
    } catch {
      // ignore and continue
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Operations
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
  const errors: string[] = error ? [safeMsg(error.message)] : [];
  return { attached, errors };
}

async function tryDetachBatch(pivot: Pivot, setId: string | number, itemIds: Array<string | number>) {
  try {
    let query = supabase.from(pivot.table).delete().eq(pivot.setCol, setId);
    if (itemIds.length > 0) {
      query = query.in(pivot.itemCol, itemIds);
    }
    const { error } = await query;
    return { deleted: itemIds.length, error: error ? safeMsg(error.message) : null };
  } catch (error) {
    return { deleted: 0, error: safeMsg(error instanceof Error ? error.message : String(error)) };
  }
}

async function tryDeleteAllForSet(pivot: Pivot, setId: string | number) {
  try {
    await supabase.from(pivot.table).delete().eq(pivot.setCol, setId);
  } catch {
    // ignore
  }
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

function resolveRequestUserId(req: SetAttachRequest): string {
  const fromUser = typeof req.user?.id === "string" ? req.user.id : "";
  const headerValue = req.header("x-user-id");
  const fallback = typeof headerValue === "string" ? headerValue : "";
  return fromUser || fallback || "";
}

function normalizeSetId(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function normalizeMode(value: unknown): AttachMode {
  if (typeof value === "string") {
    const k = value.trim().toLowerCase();
    if (k === "detach" || k === "replace") return k;
  }
  return "attach";
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
    const candidate = (value as { id?: unknown; position?: unknown }).id;
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (!trimmed) return null;
      const position = toPosition((value as { position?: unknown }).position);
      return position != null ? { id: trimmed, position } : { id: trimmed };
    }
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      const position = toPosition((value as { position?: unknown }).position);
      return position != null ? { id: candidate, position } : { id: candidate };
    }
  }
  return null;
}

function toPosition(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function safeString(value: unknown, limit = 2_000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, limit);
}

function safeMsg(msg?: string) {
  if (!msg) return "unknown_error";
  return msg.replace(/\s+/g, " ").slice(0, 200);
}

function isProfileRow(value: unknown): value is { is_admin: boolean | null } {
  return typeof value === "object" && value !== null && "is_admin" in value;
}
