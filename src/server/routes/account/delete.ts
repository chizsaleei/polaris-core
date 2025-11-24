// polaris-core/src/server/routes/account/delete.ts

import {
  Router,
  type Request,
  type Response,
  type RequestHandler,
} from 'express'
import type { ParsedQs } from 'qs'
import { createClient } from '../../../lib/supabase'
import type { AuthInfo } from '../../middleware/auth'

const router = Router()
const supabase = createClient()

// ---------- Shared types for API and UI ----------

export type UserDeletionStatus = 'queued' | 'running' | 'finished' | 'failed'

export interface UserDeletionJobSummary {
  id: string
  status: UserDeletionStatus
  created_at: string
  scheduled_at: string | null
}

export interface UserDeletionJobFull extends UserDeletionJobSummary {
  finished_at: string | null
  error: string | null
}

export interface DeleteAccountRequestBody {
  confirm?: string
  reason?: string
  scheduleAt?: string
  userId?: string // optional admin override
}

export type DeleteAccountErrorCode =
  | 'missing_user_id'
  | 'confirmation_required'
  | 'queue_insert_failed'
  | 'internal_error'

export interface DeleteAccountErrorResponse {
  error: DeleteAccountErrorCode
}

export interface DeleteAccountAlreadyQueuedResponse {
  ok: true
  alreadyQueued: true
  job: UserDeletionJobSummary
}

export interface DeleteAccountQueuedResponse {
  ok: true
  alreadyQueued?: false
  job: UserDeletionJobSummary
}

export type DeleteAccountSuccessResponse =
  | DeleteAccountQueuedResponse
  | DeleteAccountAlreadyQueuedResponse

export type DeleteAccountResponse =
  | DeleteAccountSuccessResponse
  | DeleteAccountErrorResponse

export interface DeleteAccountStatusQuery extends ParsedQs {
  userId?: string
}

export interface DeleteAccountStatusSuccessResponse {
  ok: true
  job: UserDeletionJobFull | null
}

export type DeleteAccountStatusResponse =
  | DeleteAccountStatusSuccessResponse
  | DeleteAccountErrorResponse

// ---------- Supabase row and patch types ----------

interface UserDeletionRow {
  id: string
  user_id: string
  status: UserDeletionStatus
  reason: string | null
  source: string | null
  requested_by: string | null
  created_at: string
  scheduled_at: string | null
  finished_at: string | null
  error: string | null
}

type UserDeletionInsert = Pick<
  UserDeletionRow,
  'user_id' | 'status' | 'reason' | 'source' | 'requested_by' | 'scheduled_at'
>

interface EntitlementUpdatePatch {
  active: boolean
  updated_at: string
}

interface ProfileDeletionPatch {
  deletion_requested_at: string
}

// ---------- Auth helper ----------

type RequestWithAuth = Request & { user?: AuthInfo }

/**
 * Pull a stable user id from the auth middleware payload.
 */
export function readUserId(req: Request): string | null {
  const user = (req as RequestWithAuth).user
  if (!user) return null
  if (typeof user.userId === 'string' && user.userId.length > 0) {
    return user.userId
  }
  if ('id' in user && typeof (user as Record<string, unknown>).id === 'string') {
    return (user as Record<string, string>).id
  }
  return null
}

// ---------- Route handlers (async) ----------

export async function handleDeleteAccount(
  req: Request<never, DeleteAccountResponse, DeleteAccountRequestBody>,
  res: Response<DeleteAccountResponse>,
): Promise<void> {
  try {
    const body = req.body
    const headerUser = readUserId(req)
    const userId = headerUser || body.userId || null

    if (!userId) {
      res.status(401).json({ error: 'missing_user_id' })
      return
    }

    if (!body.confirm || body.confirm.toUpperCase() !== 'DELETE') {
      res.status(400).json({ error: 'confirmation_required' })
      return
    }

    const scheduledAt =
      (body.scheduleAt && new Date(body.scheduleAt).toISOString()) ||
      new Date().toISOString()
    const reason = body.reason || 'user_request'

    const activeStatuses: UserDeletionStatus[] = ['queued', 'running']

    // 1) If there is already a queued or running job, return it (idempotent)
    const existingResp = await supabase
      .from('user_deletions')
      .select('id,status,created_at,scheduled_at')
      .eq('user_id', userId)
      .in('status', activeStatuses)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingResp.error) {
      console.error('[account/delete] select existing error', existingResp.error)
      res.status(500).json({ error: 'internal_error' })
      return
    }

    const existingJob = existingResp.data as UserDeletionRow | null
    if (existingJob) {
      const jobSummary: UserDeletionJobSummary = {
        id: existingJob.id,
        status: existingJob.status,
        created_at: existingJob.created_at,
        scheduled_at: existingJob.scheduled_at,
      }

      const response: DeleteAccountAlreadyQueuedResponse = {
        ok: true,
        alreadyQueued: true,
        job: jobSummary,
      }

      res.status(200).json(response)
      return
    }

    // 2) Insert deletion job
    const insertPayload: UserDeletionInsert = {
      user_id: userId,
      status: 'queued',
      reason,
      source: 'api',
      requested_by: 'user',
      scheduled_at: scheduledAt,
    }

    const insertResp = await supabase
      .from('user_deletions')
      .insert(insertPayload)
      .select('id,status,scheduled_at,created_at')
      .single()

    if (insertResp.error || !insertResp.data) {
      console.error('[account/delete] insert error', insertResp.error)
      res.status(500).json({ error: 'queue_insert_failed' })
      return
    }
    const inserted = insertResp.data as UserDeletionRow

    const jobSummary: UserDeletionJobSummary = {
      id: inserted.id,
      status: inserted.status,
      created_at: inserted.created_at,
      scheduled_at: inserted.scheduled_at,
    }

    // 3) Soft disable entitlements immediately (best effort)
    const entPatch: EntitlementUpdatePatch = {
      active: false,
      updated_at: new Date().toISOString(),
    }

    await supabase
      .from('entitlements')
      .update(entPatch)
      .eq('user_id', userId)

    // 4) Mark profile flag if column exists (best effort)
    const profilePatch: ProfileDeletionPatch = {
      deletion_requested_at: new Date().toISOString(),
    }

    await supabase
      .from('profiles')
      .update(profilePatch)
      .eq('user_id', userId)

    const response: DeleteAccountQueuedResponse = {
      ok: true,
      job: jobSummary,
    }

    res.status(202).json(response)
  } catch (err: unknown) {
    console.error('[account/delete] unexpected', err)
    res.status(500).json({ error: 'internal_error' })
  }
}

export async function handleDeleteAccountStatus(
  req: Request<never, DeleteAccountStatusResponse, void, DeleteAccountStatusQuery>,
  res: Response<DeleteAccountStatusResponse>,
): Promise<void> {
  try {
    const headerUser = readUserId(req)
    const queryUserId =
      typeof req.query.userId === 'string' ? req.query.userId : ''
    const userId = headerUser || (queryUserId || null)

    if (!userId) {
      res.status(401).json({ error: 'missing_user_id' })
      return
    }

    const latestResp = await supabase
      .from('user_deletions')
      .select('id,status,created_at,scheduled_at,finished_at,error')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (latestResp.error) {
      console.error('[account/delete/status] select error', latestResp.error)
      res.status(500).json({ error: 'internal_error' })
      return
    }

    const latestJob = latestResp.data as UserDeletionRow | null
    const job: UserDeletionJobFull | null = latestJob
      ? {
          id: latestJob.id,
          status: latestJob.status,
          created_at: latestJob.created_at,
          scheduled_at: latestJob.scheduled_at,
          finished_at: latestJob.finished_at,
          error: latestJob.error,
        }
      : null

    const response: DeleteAccountStatusSuccessResponse = {
      ok: true,
      job,
    }

    res.status(200).json(response)
  } catch (err: unknown) {
    console.error('[account/delete/status] unexpected', err)
    res.status(500).json({ error: 'internal_error' })
  }
}

// ---------- Route wiring (non async to satisfy no-misused-promises) ----------

type DeleteAccountHandler = RequestHandler<
  never,
  DeleteAccountResponse,
  DeleteAccountRequestBody
>
const deleteAccountHandler: DeleteAccountHandler = (req, res) => {
  void handleDeleteAccount(req, res)
}

type DeleteAccountStatusHandler = RequestHandler<
  never,
  DeleteAccountStatusResponse,
  void,
  DeleteAccountStatusQuery
>
const deleteAccountStatusHandler: DeleteAccountStatusHandler = (req, res) => {
  void handleDeleteAccountStatus(req, res)
}

router.post('/', deleteAccountHandler)
router.get('/status', deleteAccountStatusHandler)

// Named export for app wiring and tests
export const accountDeleteRouter = router

// Default export for existing imports
export default router
