// ── Plan-mode investigation (New Run chat) ───────────────────────────────────
//
// Durable record of a Coro plan-mode conversation. The dashboard New Run
// UI lists and reloads these; the runner persists them through StateBackend
// (SQLite locally, Postgres in hybrid). `items` is the opaque UI transcript
// (ActivityItem[]); `turns` is the runner's LLM history including clamped
// tool evidence. Runtime helpers live in the runner, not here.

export type InvestigationStatus = 'active' | 'dispatched' | 'closed'

export interface InvestigationTurnEvidence {
  name: string
  args: string
  result: string
  failed?: boolean
}

export interface InvestigationTurn {
  user: string
  assistant: string
  evidence: InvestigationTurnEvidence[]
}

export interface InvestigationModelChoice {
  provider: string
  model: string
}

export interface InvestigationReadiness {
  state: 'investigating' | 'ready' | 'no-run-needed'
  openQuestions: string[]
  note: string
}

/**
 * Dual-shape resume blob, matching job `ExecutorSessionState` without
 * importing the plugin SDK into this package.
 */
export interface InvestigationExecutorSession {
  sessionId?: string
  conversationHistory?: unknown[]
}

export interface Investigation {
  id: string
  title: string
  status: InvestigationStatus
  /** Dashboard activity feed. Opaque to the runner. */
  items: unknown[]
  turns: InvestigationTurn[]
  /** Dual-shape resume blob. `null` on a patch clears a stale Claude/OpenAI session. */
  executorSession?: InvestigationExecutorSession | null
  executorId?: string | null
  modelChoice: InvestigationModelChoice
  readiness: InvestigationReadiness | null
  turnCount: number
  tokens: number
  contextUsed: number
  dispatchedJobId?: string | null
  createdAt: string
  updatedAt: string
}

/** List-row shape — no transcript, no tool evidence. */
export interface InvestigationSummary {
  id: string
  title: string
  status: InvestigationStatus
  readiness: InvestigationReadiness | null
  turnCount: number
  dispatchedJobId?: string | null
  updatedAt: string
}

/** Partial write. `id` is required; omitted fields keep their previous value. */
export type InvestigationPatch = Pick<Investigation, 'id'> & Partial<Omit<Investigation, 'id' | 'createdAt'>>

export interface InvestigationListQuery {
  limit: number
  offset: number
}

export interface InvestigationListResult {
  sessions: InvestigationSummary[]
  total: number
  limit: number
  offset: number
}

export const INVESTIGATION_LIST_DEFAULT_LIMIT = 5
export const INVESTIGATION_LIST_MAX_LIMIT = 50
