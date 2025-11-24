/**
 * Polaris Core - Materialized Views Refresh Job
 *
 * Goal
 *  - Refresh materialized views that power dashboards and weekly recaps
 *  - Fall back to a generic RPC if per view RPCs are not present
 *  - Log one maintenance row with results for audit
 *
 * Assumptions
 *  - You created one of the following on the DB side:
 *      1) Specific RPCs:
 *         - refresh_mv_user_progress()
 *         - refresh_mv_drill_stats()
 *         - refresh_mv_weekly_usage()
 *      2) Or a generic RPC:
 *         - refresh_materialized_view(p_view_name text)
 *
 * Safe to run multiple times per day.
 */

import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { ENV } from '../../config/env'

type ViewSpec = {
  viewName: string
  rpcSpecific?: string
}

export interface RefreshViewsOptions {
  dryRun?: boolean
  // Override the default set by passing view names. We will try specific RPC first, then generic RPC.
  views?: string[]
}

const supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'public' },
  auth: { persistSession: false, autoRefreshToken: false },
})

// Default set that fits Polaris dashboards mentioned in the scope
const DEFAULT_VIEWS: ViewSpec[] = [
  { viewName: 'mv_user_progress', rpcSpecific: 'refresh_mv_user_progress' },
  { viewName: 'mv_drill_stats', rpcSpecific: 'refresh_mv_drill_stats' },
  { viewName: 'mv_weekly_usage', rpcSpecific: 'refresh_mv_weekly_usage' },
]

export async function runRefreshViews(opts: RefreshViewsOptions = {}) {
  const batchId = rid()
  const startedAt = new Date().toISOString()

  const views = resolveViews(opts.views)
  const results: Array<RefreshResult> = []

  for (const v of views) {
    const r = await refreshOne(v, !!opts.dryRun)
    results.push(r)
  }

  const wrote = await logMaintenance({
    job: 'refresh_views',
    batchId,
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: !!opts.dryRun,
    results,
  })

  return {
    ok: results.every((r) => r.ok),
    refreshed: results.filter((r) => r.ok).length,
    attempted: results.length,
    logged: wrote,
    batchId,
  }
}

type RefreshResult = {
  view: string
  ok: boolean
  method: 'specific' | 'generic' | 'dry_run'
  ms: number
  error?: string
}

function resolveViews(override?: string[]): ViewSpec[] {
  if (override && override.length > 0) {
    // When overriding, we do not know specific RPC names. We will try generic RPC only.
    return override.map((name) => ({ viewName: name }))
  }
  return DEFAULT_VIEWS
}

async function refreshOne(spec: ViewSpec, dryRun: boolean): Promise<RefreshResult> {
  const t0 = Date.now()
  if (dryRun) {
    return { view: spec.viewName, ok: true, method: 'dry_run', ms: Date.now() - t0 }
  }

  // 1) Try specific RPC if provided
  if (spec.rpcSpecific) {
    const { error } = await supabase.rpc(spec.rpcSpecific as any)
    if (!error) {
      return { view: spec.viewName, ok: true, method: 'specific', ms: Date.now() - t0 }
    }
    // If function does not exist, fall through to generic
    const notFound =
      typeof error?.message === 'string' &&
      (error.message.includes('function') && error.message.includes('does not exist'))
    if (!notFound) {
      return { view: spec.viewName, ok: false, method: 'specific', ms: Date.now() - t0, error: error.message }
    }
  }

  // 2) Try generic refresh RPC with parameter p_view_name
  const { error: e2 } = await supabase.rpc('refresh_materialized_view' as any, {
    p_view_name: spec.viewName,
  })
  if (!e2) {
    return { view: spec.viewName, ok: true, method: 'generic', ms: Date.now() - t0 }
  }

  return { view: spec.viewName, ok: false, method: 'generic', ms: Date.now() - t0, error: e2.message }
}

// Maintenance logging

type MaintenanceLogInsert = {
  job: 'refresh_views'
  batch_id: string
  dry_run: boolean
  results_json: RefreshResult[]
  started_at: string
  finished_at: string
}

async function logMaintenance(input: {
  job: 'refresh_views'
  batchId: string
  startedAt: string
  finishedAt: string
  dryRun: boolean
  results: RefreshResult[]
}) {
  try {
    // Optional table. Create it with:
    // create table if not exists maintenance_log (
    //   id bigserial primary key,
    //   job text not null,
    //   batch_id text not null,
    //   dry_run boolean not null default false,
    //   results_json jsonb not null,
    //   started_at timestamptz not null,
    //   finished_at timestamptz not null,
    //   created_at timestamptz not null default now()
    // );
    const row: MaintenanceLogInsert = {
      job: input.job,
      batch_id: input.batchId,
      dry_run: input.dryRun,
      results_json: input.results,
      started_at: input.startedAt,
      finished_at: input.finishedAt,
    }
    const { error } = await supabase.from('maintenance_log').insert(row)
    if (error) {
      console.error('[refresh-views] log insert failed', error)
      return 0
    }
    return input.results.length
  } catch (e) {
    console.error('[refresh-views] logMaintenance error', e)
    return 0
  }
}

function rid() {
  return crypto.randomBytes(8).toString('hex')
}

// --------------- CLI ---------------
if (require.main === module) {
  // Allow overrides via simple env for one off runs
  // Example:
  // VIEWS=mv_user_progress,mv_drill_stats ts-node src/server/cron/refresh-views.ts
  const list = process.env.VIEWS?.split(',').map((s) => s.trim()).filter(Boolean)
  runRefreshViews({ views: list })
    .then((r) => console.log('[refresh-views] ok', r))
    .catch((e) => {
      console.error('[refresh-views] error', e)
      process.exit(1)
    })
}
