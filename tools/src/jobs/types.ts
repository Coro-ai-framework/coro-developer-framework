// ── Job taxonomy ─────────────────────────────────────────────────────────────

/**
 * The type of work a job performs.
 * Determines which workflowPath is used and which phases are valid.
 */
export enum JobType {
  Migration  = 'migration',
  Feature    = 'feature',
  SelfUpdate = 'self-update',
}

// ── Well-known statuses ──────────────────────────────────────────────────────

export const STATUS_QUEUED                      = 'queued'
export const STATUS_COMPLETE                    = 'complete'
export const STATUS_ESCALATED                   = 'escalated'
export const STATUS_FAILED                      = 'failed'
export const STATUS_AWAITING_PLAN_APPROVAL      = 'awaiting-plan-approval'
export const STATUS_AWAITING_PR_MERGE           = 'awaiting-pr-merge'
export const STATUS_AWAITING_DEVELOPER_INPUT    = 'awaiting-developer-input'
export const STATUS_CODING                      = 'coding'

// ── PR tracking ───────────────────────────────────────────────────────────────

export interface PrMapping {
  prId: number
  feature: string
  repoSlug: string
  openedAt: string
  mergedAt?: string
}

// ── Feature tracking ──────────────────────────────────────────────────────────

export interface FeatureItem {
  name: string
  status: 'pending' | 'in-progress' | 'complete' | 'escalated'
  loopCount: number
}

// ── Token usage tracking ─────────────────────────────────────────────────────

/** Accumulated API token usage for a job, updated live during execution. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  totalCostUsd: number
}

/** Snapshot of usage for a single completed phase. */
export interface PhaseUsage {
  phase: string
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  costUsd: number
  durationMs: number
  durationApiMs: number
  numTurns: number
  model: string
  /** Per-model breakdown when multiple models were used (e.g. subagents). */
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>
}

// ── Artefact tracking ────────────────────────────────────────────────────────

/**
 * A phase output recorded by an agent for developer visibility.
 * The code layer treats `data` as opaque — only the dashboard knows how to
 * render each `kind`. Agents use `post_artifact` to append these; the
 * dashboard reads `job.artifacts` and dispatches per kind.
 */
export interface Artifact {
  id: string
  phase: string
  kind: string
  title: string
  data: Record<string, unknown>
  createdBy: string
  createdAt: string
}

// ── Insight tracking ─────────────────────────────────────────────────────────

/** A learning or workaround discovered by any agent during execution. */
export interface Insight {
  phase: string
  category: string
  summary: string
  detail: string
  suggestion?: string
}

// ── Core Job type ─────────────────────────────────────────────────────────────

export interface Job {
  id: string
  type: JobType
  workflowPath: string

  /**
   * All job-specific parameters in a single generic bag.
   * Common keys: serviceName, repoSlug, projects, reviewers, stagingUrl,
   * description, jiraTicketId, branchName, changedFiles, prId, language
   */
  params: Record<string, unknown>

  triggerSource: 'cli' | 'jira' | 'internal'

  status: string
  phase: string
  currentFeature: string | null

  /** Populated by planner via set_features tool. The runner does not act on these. */
  features: FeatureItem[]
  /** Current feature's loop count — denormalized from features[] for quick access. */
  featureLoopCount: number

  prMappings: PrMapping[]

  /**
   * Interactive mode — when true, the runner parks at phase boundaries that
   * have `interactive_checkpoint: true` in the workflow YAML, waiting for
   * developer approval before advancing.
   */
  interactive: boolean

  /**
   * Artefacts posted by agents during execution (plan files, PR links, test
   * results, etc.). The code layer stores these as opaque JSON; the dashboard
   * renders them per `kind`.
   */
  artifacts: Artifact[]

  /**
   * When parked waiting for developer input at a phase boundary, this records
   * the phase the job will advance to on approval. Unset for agent-requested
   * mid-phase pauses (where the job stays on the current phase).
   */
  awaitingNextPhase?: string

  /** Accumulated learnings from all agents. The evaluator reviews these and decides what to propose. */
  insights: Insight[]

  /** Running token usage totals — updated incrementally during execution. */
  tokenUsage: TokenUsage
  /** Per-phase usage snapshots — appended when each phase completes. */
  phaseUsage: PhaseUsage[]

  /**
   * Agent SDK session ID for this job. Used to resume conversations
   * when the job is un-parked by a webhook event.
   */
  sessionId?: string

  createdAt: string
  updatedAt: string

  awaitingEvent?: string
  awaitingPrId?: number
  escalationMessage?: string

  /**
   * Injected by the dispatcher when a webhook event resumes the job.
   * The runner uses this as the prompt for the resumed turn, then clears it.
   */
  pendingPrompt?: string
}

// ── Convenience accessors ─────────────────────────────────────────────────────

export function jobParam<T = string>(job: Job, key: string, fallback: T): T {
  const val = job.params[key]
  return (val as T) ?? fallback
}

export function jobReviewers(job: Job): string[] {
  const r = job.params['reviewers']
  return Array.isArray(r) ? r as string[] : []
}

export function jobRepoSlug(job: Job): string {
  return (job.params['repoSlug'] as string) ?? ''
}

export function jobServiceName(job: Job): string {
  return (job.params['serviceName'] as string) ?? ''
}

export function jobJiraTicketId(job: Job): string | undefined {
  return job.params['jiraTicketId'] as string | undefined
}

// ── Job input ─────────────────────────────────────────────────────────────────

export interface JobInput {
  type: 'migration' | 'feature' | 'self-update'
  triggerSource?: 'cli' | 'jira' | 'internal'
  params: Record<string, unknown>
}

// ── Proposals ─────────────────────────────────────────────────────────────────

export type ProposalType =
  | 'new-tool'
  | 'modify-tool'
  | 'new-workflow'
  | 'modify-workflow'
  | 'new-agent'
  | 'modify-agent'
  | 'memory-update'
  | 'source-change'
  | 'skill-create'
  | 'skill-update'
  | 'claude-md-update'

export type ProposalStatus = 'pending' | 'approved' | 'rejected'

export interface ProposalFile {
  path: string
  content: string
}

export interface Proposal {
  id: string
  tenantId: string
  jobId: string
  type: ProposalType
  title: string
  rationale: string
  description: string
  status: ProposalStatus
  files: ProposalFile[]
  createdAt: string
  updatedAt: string
  reviewedBy?: string
  reviewNote?: string
}

// ── Token usage helpers ───────────────────────────────────────────────────────

export function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalCostUsd: 0,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function isTerminalStatus(status: string): boolean {
  return status === STATUS_COMPLETE
}

/**
 * Has the runner stopped processing this job?
 * Includes terminal (complete) and stopped-with-reason (failed, escalated).
 * Used by SSE to close the log stream — no more logs will be produced until
 * a manual resume. Distinct from isParkingStatus (which covers awaiting-*
 * states where the stream may stay open for webhook-driven resume).
 */
export function isStoppedStatus(status: string): boolean {
  return (
    status === STATUS_COMPLETE ||
    status === STATUS_FAILED ||
    status === STATUS_ESCALATED
  )
}

/**
 * Can this job be woken up by an external event?
 * Includes explicit parking states AND escalated/failed — because a webhook
 * event (comment, approval, merge) may provide exactly the context the agent
 * needs to continue. The AI decides whether to proceed or re-escalate.
 * Only `complete` is truly unreachable.
 */
export function isParkingStatus(status: string): boolean {
  return (
    status === STATUS_AWAITING_PLAN_APPROVAL ||
    status === STATUS_AWAITING_PR_MERGE ||
    status === STATUS_AWAITING_DEVELOPER_INPUT ||
    status === STATUS_ESCALATED ||
    status === STATUS_FAILED
  )
}

export function defaultWorkflowPath(type: JobType): string {
  switch (type) {
    case JobType.Migration:  return 'workflows/migration/workflow.md'
    case JobType.Feature:    return 'workflows/feature/workflow.md'
    case JobType.SelfUpdate: return ''
  }
}
