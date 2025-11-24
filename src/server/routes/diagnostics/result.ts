// src/server/routes/diagnostics/result.ts
import type { Request, Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { Router } from "express";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";
import { DISCLAIMERS } from "../../../lib/constants";

const router = Router();

type DiagnosticsRequest = Request<ParamsDictionary>;

/** Narrow DB row shape we read from diagnostic_runs (plus joined form) */
interface DbRunRow {
  id: string;
  form_id: string | null;
  state: string | null;
  started_at: string | null;
  completed_at: string | null;
  duration_sec: number | null;
  score_total: number | null;
  notes: string | null;
  form: {
    id: string;
    code: string | null;
    title: string | null;
    summary: string | null;
    coach_id: string | null;
    config: Record<string, unknown> | null;
  } | null;
}

interface RunSummary {
  id: string;
  state: string;
  startedAt: string | null;
  completedAt: string | null;
  durationSec: number | null;
  scoreTotal: number | null;
  notes: string | null;
  form: {
    id: string;
    code: string;
    title: string;
    summary: string | null;
    coachId: string;
    config: Record<string, unknown>;
  } | null;
}

interface ItemResult {
  id: string;
  formItemId: string;
  idx: number;
  status: string;
  drillId: string | null;
  score: number | null;
  durationSec: number | null;
  responseText: string | null;
  responseUrl: string | null;
  rubric: Record<string, unknown> | null;
}

interface SectionResult {
  id: string;
  idx: number;
  title: string;
  targetTopics: string[];
  timeLimitSec: number | null;
  stats: {
    totalItems: number;
    scoredItems: number;
    averageScore: number | null;
    averageDurationSec: number | null;
    completionRate: number;
  };
  items: ItemResult[];
}

interface AnalysisSummary {
  overallScore: number | null;
  totalItems: number;
  scoredItems: number;
  timeSpentSec: number;
  wins: string[];
  fixes: string[];
  nextTopics: string[];
  summary: string;
  recommendedCoach: string | null;
}

router.get("/", (req: DiagnosticsRequest, res: Response) => {
  void runWithRequestContext({ headers: req.headers, user_id: req.user?.userId }, async () => {
    try {
      const userId = req.user?.userId || req.header("x-user-id");
      if (!userId) {
        sendError(res, 401, "unauthorized", "Missing user id.");
        return;
      }

      const runIdParam = firstString(req.query.runId ?? req.query.run_id);
      const includeIncomplete = parseBoolean(firstString(req.query.includeIncomplete ?? req.query.include_incomplete));

      const supabase = createClient();

      const runRow = await fetchRunRow(supabase, String(userId), runIdParam, includeIncomplete);
      if (!runRow) {
        sendError(res, 404, "not_found", "No diagnostic run found for this request.");
        return;
      }

      const run = mapRun(runRow);
      const formId = run.form?.id || (runRow.form_id ? String(runRow.form_id) : "");

      if (!formId) {
        const analysis = buildAnalysis(run, [], { totalItems: 0, scoredItems: 0, timeSpentSec: 0 });
        const disclaimer = disclaimerFor(run.form?.coachId);
        res.status(200).json({
          ok: true,
          data: { run, sections: [] as SectionResult[], analysis, disclaimer },
          correlation_id: getCorrelationId(),
        });
        return;
      }

      const { sections, totals } = await fetchSectionsAndItems(supabase, run.id, formId);
      const analysis = buildAnalysis(run, sections, totals);
      const disclaimer = disclaimerFor(run.form?.coachId);

      res.status(200).json({
        ok: true,
        data: {
          run,
          sections,
          analysis,
          disclaimer,
        },
        correlation_id: getCorrelationId(),
      });
    } catch (error) {
      log.error("diagnostics/result error", { err: safeError(error) });
      sendError(res, 500, "internal_error", "Unable to load diagnostic result.");
    }
  });
});

export default router;

// -----------------------------------------------------------------------------
// Data fetch helpers
// -----------------------------------------------------------------------------

async function fetchRunRow(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  runIdParam?: string,
  includeIncomplete = false,
): Promise<DbRunRow | null> {
  const base = supabase
    .from("diagnostic_runs")
    .select(
      [
        "id",
        "form_id",
        "state",
        "started_at",
        "completed_at",
        "duration_sec",
        "score_total",
        "notes",
        "form:diagnostic_forms(id, code, title, summary, coach_id, config)",
      ].join(","),
    )
    .eq("user_id", userId);

  if (runIdParam) {
    if (!isUuid(runIdParam)) {
      throw makeHttpError(400, "invalid_run_id", "runId must be a valid UUID.");
    }
    const { data, error } = await base.eq("id", runIdParam).maybeSingle();
    if (error) handleDbError("fetchRunById", error);
    return (data as unknown as DbRunRow) ?? null;
  }

  const query = includeIncomplete ? base : base.eq("state", "completed");
  const { data, error } = await query
    .order("completed_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) handleDbError("fetchLatestRun", error);
  return (data as unknown as DbRunRow) ?? null;
}

async function fetchSectionsAndItems(
  supabase: ReturnType<typeof createClient>,
  runId: string,
  formId: string,
): Promise<{ sections: SectionResult[]; totals: { totalItems: number; scoredItems: number; timeSpentSec: number } }> {
  const [{ data: sectionRows, error: sectionError }, { data: itemRows, error: itemError }] = await Promise.all([
    supabase
      .from("diagnostic_form_sections")
      .select("id, idx, title, target_topics, time_limit_sec")
      .eq("form_id", formId)
      .order("idx"),
    supabase
      .from("diagnostic_run_items")
      .select("id, form_item_id, section_id, idx, drill_id, status, score, duration_sec, response_text, response_url, rubric")
      .eq("run_id", runId)
      .order("idx"),
  ]);

  if (sectionError) handleDbError("fetchSections", sectionError);
  if (itemError) handleDbError("fetchRunItems", itemError);

  const sectionList: SectionResult[] = (sectionRows ?? []).map((row) => ({
    id: String(row.id),
    idx: Number(row.idx ?? 0),
    title: String(row.title ?? ""),
    targetTopics: toStringArray(row.target_topics),
    timeLimitSec: toInt(row.time_limit_sec),
    stats: {
      totalItems: 0,
      scoredItems: 0,
      averageScore: null,
      averageDurationSec: null,
      completionRate: 0,
    },
    items: [],
  }));

  const sectionById = new Map(sectionList.map((section) => [section.id, section]));
  let totalItems = 0;
  let scoredItems = 0;
  let timeSpentSec = 0;

  for (const raw of itemRows ?? []) {
    const sectionId = String(raw.section_id);
    const section = sectionById.get(sectionId);
    if (!section) continue;

    const item = mapItem(raw);
    section.items.push(item);
    section.stats.totalItems += 1;

    if (item.score != null) {
      section.stats.scoredItems += 1;
      scoredItems += 1;
    }
    if (item.durationSec != null) {
      timeSpentSec += item.durationSec;
    }

    totalItems += 1;
  }

  for (const section of sectionList) {
    section.items.sort((a, b) => a.idx - b.idx);
    section.stats.averageScore = average(section.items.map((item) => item.score).filter(isNumber));
    section.stats.averageDurationSec = average(section.items.map((item) => item.durationSec).filter(isNumber));
    section.stats.completionRate =
      section.stats.totalItems > 0 ? roundTo(section.stats.scoredItems / section.stats.totalItems, 2) : 0;
    if (section.stats.averageDurationSec != null) {
      section.stats.averageDurationSec = Math.round(section.stats.averageDurationSec);
    }
  }

  return {
    sections: sectionList,
    totals: { totalItems, scoredItems, timeSpentSec },
  };
}

// -----------------------------------------------------------------------------
// Mapping & analysis
// -----------------------------------------------------------------------------

function mapRun(row: DbRunRow): RunSummary {
  return {
    id: String(row.id),
    state: String(row.state ?? "created"),
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    durationSec: toInt(row.duration_sec),
    scoreTotal: toNumber(row.score_total),
    notes: typeof row.notes === "string" ? row.notes : null,
    form: row.form
      ? {
          id: String(row.form.id),
          code: safeStringValue(row.form.code),
          title: safeStringValue(row.form.title),
          summary: typeof row.form.summary === "string" ? row.form.summary : null,
          coachId: safeStringValue(row.form.coach_id),
          config: isPlainObject(row.form.config) ? row.form.config || {} : {},
        }
      : null,
  };
}

type ItemRow = {
  id: string | number;
  form_item_id: string | number;
  section_id: string | number;
  idx?: number | null;
  drill_id?: string | number | null;
  status?: string | null;
  score?: number | null;
  duration_sec?: number | null;
  response_text?: unknown;
  response_url?: unknown;
  rubric?: unknown;
};

function mapItem(row: ItemRow): ItemResult {
  return {
    id: String(row.id),
    formItemId: String(row.form_item_id),
    idx: Number(row.idx ?? 0),
    status: String(row.status ?? "pending"),
    drillId: row.drill_id ? String(row.drill_id) : null,
    score: toNumber(row.score),
    durationSec: toInt(row.duration_sec),
    responseText:
      typeof row.response_text === "string"
        ? row.response_text.trim().slice(0, 4000)
        : firstString(row.response_text) ?? null,
    responseUrl: typeof row.response_url === "string" ? row.response_url : null,
    rubric: isPlainObject(row.rubric) ? row.rubric : null,
  };
}

function buildAnalysis(
  run: RunSummary,
  sections: SectionResult[],
  totals: { totalItems: number; scoredItems: number; timeSpentSec: number },
): AnalysisSummary {
  const scoredSections = sections.filter((section) => section.stats.scoredItems > 0 && section.stats.averageScore != null);
  const derivedOverall = average(scoredSections.map((section) => section.stats.averageScore as number).filter(isNumber));
  const overallScore = run.scoreTotal ?? derivedOverall;

  const wins = scoredSections
    .filter((section) => (section.stats.averageScore ?? 0) >= 0.75)
    .sort((a, b) => (b.stats.averageScore as number) - (a.stats.averageScore as number))
    .slice(0, 3)
    .map((section) => `${section.title} averaged ${formatPercent(section.stats.averageScore as number)}.`);

  const fixesCandidates = scoredSections
    .filter((section) => (section.stats.averageScore ?? 1) < 0.65)
    .sort((a, b) => (a.stats.averageScore as number) - (b.stats.averageScore as number));

  const fixes = fixesCandidates
    .slice(0, 2)
    .map((section) => `${section.title} needs focus – current accuracy is ${formatPercent(section.stats.averageScore as number)}.`);

  const focusSections = fixesCandidates.length
    ? fixesCandidates
    : scoredSections.sort((a, b) => (a.stats.averageScore as number) - (b.stats.averageScore as number)).slice(0, 2);

  const topicSet = new Set<string>();
  for (const section of focusSections) {
    for (const topic of section.targetTopics) {
      if (topic) topicSet.add(topic);
    }
  }

  const summaryParts: string[] = [];
  summaryParts.push(`Completed ${totals.scoredItems}/${totals.totalItems} items`);
  if (overallScore != null) summaryParts.push(`Overall ${formatPercent(overallScore)}`);
  if (totals.timeSpentSec > 0) {
    const minutes = Math.max(1, Math.round(totals.timeSpentSec / 60));
    summaryParts.push(`Time on task ${minutes} min`);
  }

  return {
    overallScore,
    totalItems: totals.totalItems,
    scoredItems: totals.scoredItems,
    timeSpentSec: totals.timeSpentSec,
    wins,
    fixes,
    nextTopics: Array.from(topicSet).slice(0, 6),
    summary: summaryParts.join(" · "),
    recommendedCoach: run.form?.coachId ?? null,
  };
}

// -----------------------------------------------------------------------------
// Utility helpers
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

function handleDbError(label: string, error: { message: string }) {
  log.error(`diagnostics/result ${label} failed`, { err: safeError(error) });
  throw makeHttpError(500, "db_error", "Database query failed.");
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const str = firstString(item);
      if (str) return str;
    }
    return undefined;
  }
  if (value == null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value instanceof Date) {
    const str = String(value).trim();
    return str.length ? str : undefined;
  }
  return undefined;
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toInt(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => firstString(entry))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 12);
}

function average(values: Array<number | null>): number | null {
  const filtered = values.filter(isNumber);
  if (!filtered.length) return null;
  const sum = filtered.reduce((acc, value) => acc + value, 0);
  return sum / filtered.length;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function roundTo(value: number, precision: number) {
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function disclaimerFor(coachId?: string | null): string | undefined {
  if (!coachId) return undefined;
  if (coachId === "clark-atul" || coachId === "crystal-benner") return DISCLAIMERS.MEDICAL;
  if (coachId === "christopher-buffett") return DISCLAIMERS.FINANCE;
  return undefined;
}

function safeStringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value instanceof Date) {
    const str = String(value).trim();
    if (str.length) return str;
  }
  return "";
}
