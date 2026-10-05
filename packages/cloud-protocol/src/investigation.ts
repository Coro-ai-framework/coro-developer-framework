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
  /** Current investigation write-up, projected from the findings card in `items`. */
  findings: string | null
  turnCount: number
  tokens: number
  contextUsed: number
  dispatchedJobId?: string | null
  /**
   * Per-conversation tool permission overrides (plan mode). Absent fields
   * fall back to install defaults in `intake.permissions`.
   */
  toolAccess?: InvestigationToolAccess
  createdAt: string
  updatedAt: string
}

export type ToolAccessMode = 'off' | 'ask' | 'allow'

export type IntakeBuiltinCapability = 'files' | 'filesWrite' | 'shell' | 'web'

/** `mcp:<serverId>`; claude.ai account connectors use `mcp:claude_ai`. */
export type IntakeCapability = IntakeBuiltinCapability | `mcp:${string}`

/** Per-conversation overrides. Anything absent falls back to config defaults. */
export interface InvestigationToolAccess {
  capabilities: Partial<Record<IntakeBuiltinCapability, ToolAccessMode>>
  mcp: Record<string, ToolAccessMode>
  /** Rules granted "for this conversation". */
  allow: string[]
  deny: string[]
}

export type IntakePermissionDecision = 'once' | 'conversation' | 'always' | 'deny'

export type IntakePermissionRisk = 'normal' | 'mutating' | 'outside-scratch'

export interface IntakePermissionRequest {
  requestId: string
  sessionId: string
  /** `tool` = a concrete call; `capability` = model called request_tool_access. */
  kind: 'tool' | 'capability'
  capability: IntakeCapability
  /** As invoked: 'Bash', 'shell', 'WebFetch', 'mcp__linear__create_issue', 'request_tool_access'. */
  toolName: string
  /** Human title, e.g. "Run a shell command", "Enable Shell for this conversation". */
  title: string
  /** The command / URL / path / MCP tool / model's reason. Shown in a mono block. */
  subject: string
  /** Raw tool input, JSON-clamped to 2,000 chars. */
  detail?: unknown
  risk: IntakePermissionRisk
  /** Omitted when risk !== 'normal' or kind === 'capability'. */
  suggestedRule?: string
  allowedDecisions: IntakePermissionDecision[]
  createdAt: string
  expiresAt: string
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
