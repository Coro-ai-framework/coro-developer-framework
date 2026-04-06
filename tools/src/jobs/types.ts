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

// ── Core Job type ─────────────────────────────────────────────────────────────

export interface Job {
  id: string
  type: JobType
  workflowPath: string

  /**
   * All job-specific parameters in a single generic bag.
   * Common keys: serviceName, repoSlug, projects, reviewers, stagingUrl,
   * description, jiraTicketId, branchName, changedFiles, prId
   */
  params: Record<string, unknown>

  triggerSource: 'cli' | 'jira' | 'internal'

  status: string
  phase: string
  currentFeature: string | null

  prMappings: PrMapping[]

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
  return (
    status === STATUS_COMPLETE ||
    status === STATUS_ESCALATED ||
    status === STATUS_FAILED
  )
}

export function isParkingStatus(status: string): boolean {
  return (
    status === STATUS_AWAITING_PLAN_APPROVAL ||
    status === STATUS_AWAITING_PR_MERGE
  )
}

export function defaultWorkflowPath(type: JobType): string {
  switch (type) {
    case JobType.Migration:  return 'workflows/migration/workflow.md'
    case JobType.Feature:    return 'workflows/feature/workflow.md'
    case JobType.SelfUpdate: return ''
  }
}
