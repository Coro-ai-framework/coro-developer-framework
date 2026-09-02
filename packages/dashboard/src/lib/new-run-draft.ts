import type { ActivityItem } from '../components/activity/types'

export const NEW_RUN_DRAFT_KEY = 'coro.newRun.draft'
export const NEW_RUN_DRAFT_VERSION = 2 as const

export interface NewRunDraft {
  version: 2
  sessionId: string
  items: ActivityItem[]
  modelChoice: { provider: string; model: string }
  turnCount: number
  totalTokens: number
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
    if (parsed?.version !== NEW_RUN_DRAFT_VERSION) return null
    if (typeof parsed.sessionId !== 'string' || !Array.isArray(parsed.items)) return null
    return {
      version: 2,
      sessionId: parsed.sessionId,
      items: parsed.items,
      modelChoice: parsed.modelChoice ?? { provider: '', model: '' },
      turnCount: typeof parsed.turnCount === 'number' ? parsed.turnCount : 0,
      totalTokens: typeof parsed.totalTokens === 'number' ? parsed.totalTokens : 0,
    }
  } catch {
    return null
  }
}

export function saveNewRunDraft(draft: NewRunDraft): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(NEW_RUN_DRAFT_KEY, JSON.stringify(draft))
  } catch {
    // Ignore storage quota and serialization failures.
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
