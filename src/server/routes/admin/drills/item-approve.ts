// polaris-core/src/server/routes/admin/drills/item-approve.ts
import type { Request, Response } from "express";
import { Router } from "express";
import { createClient } from "../../../../lib/supabase";

const router = Router();
const supabase = createClient();

type ItemApproveBody = {
  id?: string | number;
  nextState?: string;
  rubricId?: string | number;
  changelog?: string;
};

type ItemApproveRequest = Request<Record<string, never>, unknown, ItemApproveBody> & {
  user?: { id?: string | null } | null;
};

interface DrillRow extends Record<string, unknown> {
  id: string | number;
  state?: string | null;
  workflow_state?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  published_by?: string | null;
  published_at?: string | null;
  is_public?: boolean | null;
  version?: number | null;
  rubric_id?: string | number | null;
  changelog?: string | null;
  updated_at?: string | null;
}

interface ProfileRow extends Record<string, unknown> {
  is_admin: boolean | null;
}

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
  name: "admin_drill_state_change";
  user_id: string | null;
  tier: "admin";
  coach_id: string | null;
  meta: AdminLogPayload;
};

router.post("/", (req: ItemApproveRequest, res: Response) => {
  void handleItemApprove(req, res);
});

const handleItemApprove = async (req: ItemApproveRequest, res: Response) => {
  try {
    const uid = resolveRequestUserId(req);
    if (!(await isAdminUser(uid))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const body: ItemApproveBody = req.body || {};
    const { id, nextState, rubricId, changelog } = body;

    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }

    const target = String(nextState || "approved").toLowerCase();
    if (!["approved", "published"].includes(target)) {
      res.status(400).json({ error: "invalid_next_state" });
      return;
    }

    const drillResult = await supabase
      .from("drills")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (drillResult.error) {
      res.status(500).json({ error: "load_failed", detail: safeMsg(drillResult.error.message) });
      return;
    }

    const drillData: unknown = drillResult.data;
    if (!drillData) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!isDrillRow(drillData)) {
      res.status(500).json({ error: "invalid_drill_row" });
      return;
    }
    const drill = drillData;

    const currentState = resolveCurrentState(drill);

    if (!isAllowedTransition(currentState, target)) {
      res.status(409).json({ error: "invalid_transition", from: currentState, to: target });
      return;
    }

    const patch: Record<string, unknown> = {};

    if ("state" in drill) patch.state = target;
    else if ("workflow_state" in drill) patch.workflow_state = target;

    const nowIso = new Date().toISOString();

    if (target === "approved") {
      if ("approved_by" in drill) patch.approved_by = uid || null;
      if ("approved_at" in drill) patch.approved_at = nowIso;
      if ("version" in drill) patch.version = Number(drill.version ?? 0) + 1;
    }

    if (target === "published") {
      if ("approved_by" in drill && !drill.approved_by) patch.approved_by = uid || null;
      if ("approved_at" in drill && !drill.approved_at) patch.approved_at = nowIso;

      if ("published_by" in drill) patch.published_by = uid || null;
      if ("published_at" in drill) patch.published_at = nowIso;
      if ("is_public" in drill) patch.is_public = true;
      if ("version" in drill) patch.version = Number(drill.version ?? 0) + 1;
    }

    if (rubricId != null) {
      if ("rubric_id" in drill) patch.rubric_id = rubricId;
    }

    const cleanChangelog = typeof changelog === "string" ? changelog.trim() : "";
    if (cleanChangelog && "changelog" in drill) {
      const prev = typeof drill.changelog === "string" ? drill.changelog : "";
      const entry = `[${nowIso}] ${uid || "admin"} • ${target.toUpperCase()}: ${cleanChangelog}`;
      patch.changelog = prev ? `${prev}\n${entry}` : entry;
    }

    patch.updated_at = nowIso;

    const updateResult = await supabase
      .from("drills")
      .update(patch)
      .eq("id", id)
      .select("*")
      .maybeSingle();

    if (updateResult.error) {
      res.status(500).json({ error: "update_failed", detail: safeMsg(updateResult.error.message) });
      return;
    }

    const updatedRecord: unknown = updateResult.data;
    if (!updatedRecord || !isDrillRow(updatedRecord)) {
      res.status(500).json({ error: "update_failed" });
      return;
    }

    await logAdminAction({
      kind: "drill_state_change",
      userId: uid || null,
      drillId: String(id),
      from: currentState,
      to: target,
      note: cleanChangelog || null,
    });

    res.status(200).json({ ok: true, drill: updatedRecord });
  } catch (error) {
    console.error("[admin/drills/item-approve] error", error);
    res.status(500).json({ error: "internal_error" });
  }
};

export default router;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function resolveRequestUserId(req: ItemApproveRequest): string {
  const fromUser = typeof req.user?.id === "string" ? req.user.id : "";
  const headerValue = req.header("x-user-id");
  const fallback = typeof headerValue === "string" ? headerValue : "";
  return fromUser || fallback || "";
}

async function isAdminUser(userId?: string): Promise<boolean> {
  if (!userId) return false;

  // Allow-list by env
  const allow = String(process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.includes(userId)) return true;

  // RPC first if present
  try {
    const rpc = await supabase.rpc("is_admin", { p_user_id: userId }).single();
    if (!rpc.error && rpc.data === true) return true;
  } catch {
    // ignore
  }

  // Fall back to profiles.is_admin if column exists
  try {
    const prof = await supabase.from("profiles").select("is_admin").eq("user_id", userId).maybeSingle();
    const profileData: unknown = prof.data;
    if (isProfileRow(profileData) && profileData.is_admin) return true;
  } catch {
    // ignore
  }

  return false;
}

function isAllowedTransition(from: string, to: string) {
  if (from === to) return true;
  const order = ["draft", "auto_qa", "in_review", "approved", "published", "deprecated"];
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return false;

  // Allow forward moves and approving from in_review or auto_qa
  if (to === "approved" && (from === "in_review" || from === "auto_qa" || from === "draft")) return true;
  if (to === "published" && (from === "approved" || from === "in_review")) return true;
  return b >= a; // generic forward move
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

  // Try admin_messages first. If missing, try events as a fallback.
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
      name: "admin_drill_state_change",
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

function resolveCurrentState(drill: DrillRow): string {
  const candidate =
    (typeof drill.state === "string" && drill.state) ||
    (typeof drill.workflow_state === "string" && drill.workflow_state) ||
    "draft";
  return candidate.toLowerCase();
}
