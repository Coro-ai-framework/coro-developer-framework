import type { ActivityItem } from '../components/activity/types'
import type { Readiness } from './intake-readiness'

export const NEW_RUN_DRAFT_KEY = 'coro.newRun.draft'
export const NEW_RUN_DRAFT_VERSION = 3 as const

export interface NewRunDraft {
  version: 3
  sessionId: string
  items: ActivityItem[]
  modelChoice: { provider: string; model: string }
  turnCount: number
  totalTokens: number
  /** Tokens resident in the model's context after the last turn. */
  contextUsed: number
  readiness: Readiness | null
}

export function mintSessionId(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `intake-${Date.now()}`
}

export function loadNewRunDraft(): NewRunDraft | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(NEW_RUN_DRAFT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as NewRunDraft
    // Version 2 drafts carry `brief` cards and a client-owned transcript the
    // runner no longer accepts; there is nothing to migrate, so they are
    // dropped and the developer starts a fresh conversation.
    if (parsed?.version !== NEW_RUN_DRAFT_VERSION) return null
    if (typeof parsed.sessionId !== 'string' || !Array.isArray(parsed.items)) return null
    return {
      version: 3,
      sessionId: parsed.sessionId,
      items: parsed.items,
      modelChoice: parsed.modelChoice ?? { provider: '', model: '' },
      turnCount: typeof parsed.turnCount === 'number' ? parsed.turnCount : 0,
      totalTokens: typeof parsed.totalTokens === 'number' ? parsed.totalTokens : 0,
      contextUsed: typeof parsed.contextUsed === 'number' ? parsed.contextUsed : 0,
      readiness: parsed.readiness ?? null,
    }
  } catch {
    return null
  }
}

export function clearNewRunDraftStorage(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(NEW_RUN_DRAFT_KEY)
  } catch {
    // ignore
  }
}

export function clearOrphanedIntakeKeys(): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.removeItem('coro.intake.modeChoice')
    window.localStorage.removeItem('coro.intake.askEachTimeChoice')
  } catch {
    // ignore
  }
}
