import type {
  Investigation,
  InvestigationExecutorSession,
  InvestigationPatch,
  InvestigationStatus,
} from '@coro-ai/cloud-protocol'
import type { ExecutorSessionState } from '@coro-ai/plugin-sdk'
import type { StateBackend } from '../state/backend'
import {
  investigationIsPersistable,
  mergeInvestigation,
  titleFromTurns,
} from '../state/investigation'
import {
  hydrateIntakeSession,
  isIntakeSessionDiscarded,
  peekIntakeSession,
  type IntakeSession,
} from './session-store'

/** Loads a durable investigation row into the hot cache. */
export function hydrateIntakeSessionFromRecord(record: Investigation): IntakeSession {
  return hydrateIntakeSession({
    id: record.id,
    turns: record.turns,
    tokens: record.tokens,
    contextTokens: record.contextUsed,
    ...(record.executorSession
      ? { executorSession: record.executorSession as ExecutorSessionState }
      : {}),
    ...(record.executorId ? { executorId: record.executorId } : {}),
    ...(record.toolAccess ? { toolAccess: record.toolAccess } : {}),
  })
}

/**
 * Brings a conversation the cache no longer holds (idle eviction, runner
 * restart) back from its durable row, so the next turn resumes the
 * executor session and keeps the recorded tool evidence. Without this the
 * turn was rebuilt from the browser's prose-only transcript and the model
 * started over. Returns true when it hydrated.
 */
export async function restoreIntakeSession(backend: StateBackend, sessionId: string): Promise<boolean> {
  if (peekIntakeSession(sessionId) || isIntakeSessionDiscarded(sessionId)) return false
  const record = await backend.getInvestigation(sessionId)
  if (!record || peekIntakeSession(sessionId)) return false
  hydrateIntakeSessionFromRecord(record)
  return true
}

export async function persistLiveIntakeSession(
  backend: StateBackend,
  sessionId: string,
  extras?: Pick<InvestigationPatch, 'modelChoice' | 'title'>,
): Promise<Investigation | null> {
  if (isIntakeSessionDiscarded(sessionId)) return null
  const live = peekIntakeSession(sessionId)
  if (!live || live.turns.length === 0) return null
  return backend.upsertInvestigation({
    id: sessionId,
    turns: live.turns,
    tokens: live.tokens,
    contextUsed: live.contextTokens,
    turnCount: live.turns.length,
    executorSession: (live.executorSession as InvestigationExecutorSession | undefined) ?? null,
    executorId: live.executorId ?? null,
    ...(live.toolAccess ? { toolAccess: live.toolAccess } : {}),
    title: extras?.title ?? titleFromTurns(live.turns),
    ...(extras?.modelChoice ? { modelChoice: extras.modelChoice } : {}),
  })
}

export interface IntakeSnapshotBody {
  items?: unknown[]
  readiness?: Investigation['readiness']
  findings?: string | null
  modelChoice?: Investigation['modelChoice']
  turnCount?: number
  tokens?: number
  contextUsed?: number
  title?: string
  status?: InvestigationStatus
  dispatchedJobId?: string | null
  reviewIds?: string[]
}

/**
 * Dashboard snapshot plus any live runner turns. Skips inserting an empty chat,
 * and refuses to re-create one the developer discarded.
 */
export async function persistIntakeSnapshot(
  backend: StateBackend,
  sessionId: string,
  body: IntakeSnapshotBody,
): Promise<{ persisted: boolean; session: Investigation | null }> {
  if (isIntakeSessionDiscarded(sessionId)) return { persisted: false, session: null }
  const existing = await backend.getInvestigation(sessionId)
  const live = peekIntakeSession(sessionId)
  const patch: InvestigationPatch = {
    id: sessionId,
    ...(body.items !== undefined ? { items: body.items } : {}),
    ...(body.readiness !== undefined ? { readiness: body.readiness } : {}),
    ...(body.findings !== undefined ? { findings: body.findings } : {}),
    ...(body.modelChoice !== undefined ? { modelChoice: body.modelChoice } : {}),
    ...(body.turnCount !== undefined ? { turnCount: body.turnCount } : {}),
    ...(body.tokens !== undefined ? { tokens: body.tokens } : {}),
    ...(body.contextUsed !== undefined ? { contextUsed: body.contextUsed } : {}),
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.dispatchedJobId !== undefined ? { dispatchedJobId: body.dispatchedJobId ?? null } : {}),
    ...(body.reviewIds?.length ? { reviewIds: body.reviewIds } : {}),
  }
  if (live) {
    patch.turns = live.turns
    patch.tokens = live.tokens
    patch.contextUsed = live.contextTokens
    patch.turnCount = live.turns.length
    patch.executorSession = (live.executorSession as InvestigationExecutorSession | undefined) ?? null
    patch.executorId = live.executorId ?? null
    if (live.toolAccess) patch.toolAccess = live.toolAccess
    if (!patch.title) patch.title = titleFromTurns(live.turns)
  }

  const merged = mergeInvestigation(existing, patch, new Date().toISOString())
  if (!investigationIsPersistable(merged) && !existing) {
    return { persisted: false, session: null }
  }
  const session = await backend.upsertInvestigation(patch)
  return { persisted: true, session }
}
