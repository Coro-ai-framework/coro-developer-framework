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

export const STATUS_QUEUED                = 'queued'
export const STATUS_COMPLETE              = 'complete'
export const STATUS_ESCALATED             = 'escalated'
export const STATUS_FAILED                = 'failed'
export const STATUS_AWAITING_PLAN_APPROVAL = 'awaiting-plan-approval'
export const STATUS_AWAITING_PR_MERGE     = 'awaiting-pr-merge'
export const STATUS_CODING                = 'coding'

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

  /** Accumulated learnings from all agents. The evaluator reviews these and decides what to propose. */
  insights: Insight[]

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
