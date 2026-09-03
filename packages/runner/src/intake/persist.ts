import type {
  Investigation,
  InvestigationExecutorSession,
  InvestigationPatch,
  InvestigationStatus,
} from '@coro-ai/cloud-protocol'
import type { StateBackend } from '../state/backend'
import {
  investigationIsPersistable,
  mergeInvestigation,
  titleFromTurns,
} from '../state/investigation'
import { peekIntakeSession } from './session-store'

export async function persistLiveIntakeSession(
  backend: StateBackend,
  sessionId: string,
  extras?: Pick<InvestigationPatch, 'modelChoice' | 'title'>,
): Promise<Investigation | null> {
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
    title: extras?.title ?? titleFromTurns(live.turns),
    ...(extras?.modelChoice ? { modelChoice: extras.modelChoice } : {}),
  })
}

export interface IntakeSnapshotBody {
  items?: unknown[]
  readiness?: Investigation['readiness']
  modelChoice?: Investigation['modelChoice']
  turnCount?: number
  tokens?: number
  contextUsed?: number
  title?: string
  status?: InvestigationStatus
  dispatchedJobId?: string | null
}

/**
 * Dashboard snapshot plus any live runner turns. Skips inserting an empty chat.
 */
export async function persistIntakeSnapshot(
  backend: StateBackend,
  sessionId: string,
  body: IntakeSnapshotBody,
): Promise<{ persisted: boolean; session: Investigation | null }> {
  const existing = await backend.getInvestigation(sessionId)
  const live = peekIntakeSession(sessionId)
  const patch: InvestigationPatch = {
    id: sessionId,
    ...(body.items !== undefined ? { items: body.items } : {}),
    ...(body.readiness !== undefined ? { readiness: body.readiness } : {}),
    ...(body.modelChoice !== undefined ? { modelChoice: body.modelChoice } : {}),
    ...(body.turnCount !== undefined ? { turnCount: body.turnCount } : {}),
    ...(body.tokens !== undefined ? { tokens: body.tokens } : {}),
    ...(body.contextUsed !== undefined ? { contextUsed: body.contextUsed } : {}),
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.dispatchedJobId !== undefined ? { dispatchedJobId: body.dispatchedJobId ?? null } : {}),
  }
  if (live) {
    patch.turns = live.turns
    patch.tokens = live.tokens
    patch.contextUsed = live.contextTokens
    patch.turnCount = live.turns.length
    patch.executorSession = (live.executorSession as InvestigationExecutorSession | undefined) ?? null
    patch.executorId = live.executorId ?? null
    if (!patch.title) patch.title = titleFromTurns(live.turns)
  }

  const merged = mergeInvestigation(existing, patch, new Date().toISOString())
  if (!investigationIsPersistable(merged) && !existing) {
    return { persisted: false, session: null }
  }
  const session = await backend.upsertInvestigation(patch)
  return { persisted: true, session }
}
