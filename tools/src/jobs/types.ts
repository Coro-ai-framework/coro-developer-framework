// ── Job taxonomy ─────────────────────────────────────────────────────────────

/**
 * The type of work a job performs.
 * Determines which workflowPath is used and which phases are valid.
 *
 * New workflow types (e.g. 'refactor', 'security-audit') are added here and
 * in the dispatcher — no other infrastructure changes required.
 */
export enum JobType {
  Migration  = 'migration',   // .NET → Go full service migration (CLI-triggered)
  Feature    = 'feature',     // Feature implementation (CLI or Jira-triggered)
  SelfUpdate = 'self-update', // Agent self-improvement PR (file-watcher-triggered)
}

// ── Well-known statuses ──────────────────────────────────────────────────────
//
// Job statuses are strings — workflow configs define phase-specific statuses.
// These constants cover infrastructure-level statuses the runner, dispatcher,
// and tools need to reference regardless of workflow type.

export const STATUS_QUEUED                = 'queued'
export const STATUS_COMPLETE              = 'complete'
export const STATUS_ESCALATED             = 'escalated'
export const STATUS_FAILED                = 'failed'
export const STATUS_AWAITING_PLAN_APPROVAL = 'awaiting-plan-approval'
export const STATUS_AWAITING_PR_MERGE     = 'awaiting-pr-merge'
export const STATUS_CODING                = 'coding'

// ── Conversation history ──────────────────────────────────────────────────────

/** A single message in the Claude API conversation history. */
export interface ConversationMessage {
  role: 'user' | 'assistant'
  // Claude API accepts string or array of content blocks.
  // We store as-is from the SDK response so we can replay the history exactly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  content: string | any[]
}

// ── PR tracking ───────────────────────────────────────────────────────────────

/** Maps a BitBucket PR to the feature it implements within this job. */
export interface PrMapping {
  prId: number
  feature: string    // e.g. "feature-3-users-endpoints"
  repoSlug: string
  openedAt: string   // ISO8601
  mergedAt?: string  // ISO8601, set on pr:fulfilled
}

// ── Transient runtime signals ─────────────────────────────────────────────────

/**
 * Set by job-control tools during a Claude turn.
 * Read by the runner loop AFTER the turn completes.
 * NEVER persisted to Redis — lives only in the in-process Job object.
 */
export interface JobSignals {
  phaseComplete?: boolean
  awaitingEvent?: string   // e.g. 'pr:fulfilled', 'pr:approved'
  awaitingPrId?: number
}

// ── Core Job type ─────────────────────────────────────────────────────────────

export interface Job {
  // Identity
  id: string
  type: JobType
  /** Relative path to the workflow MD file, e.g. 'workflows/migration/workflow.md' */
  workflowPath: string

  // Job parameters (set at creation, read-only after)
  serviceName: string
  repoSlug: string
  projects: string[]        // C# project names to migrate / touch
  reviewers: string[]       // BitBucket usernames to tag on PRs
  stagingUrl: string        // Base URL of the .NET staging service

  // Source context
  triggerSource: 'cli' | 'jira' | 'internal'
  jiraTicketId?: string     // populated for Jira-triggered jobs

  // Runtime state (mutated by runner)
  /** Lifecycle status — well-known values in STATUS_* constants, workflow-specific values from config */
  status: string
  /** Current phase within the workflow — defined by the workflow config front matter */
  phase: string
  currentFeature: string | null

  // PR tracking
  prMappings: PrMapping[]

  // Claude API conversation — full history replayed on each Claude call
  conversationHistory: ConversationMessage[]

  // Timestamps
  createdAt: string         // ISO8601
  updatedAt: string         // ISO8601

  // Parking state — set when job awaits an external event
  awaitingEvent?: string
  awaitingPrId?: number

  // Set by the `escalate` tool when the job needs human intervention
  escalationMessage?: string

  // ── Transient, never persisted ──────────────────────────────────────────────
  // Populated in-process by job-control tools during a Claude turn.
  // The runner reads and clears these after processing each turn.
  _signals?: JobSignals
}

// ── Input types (one per trigger source) ─────────────────────────────────────

export interface MigrationJobInput {
  type: 'migration'
  repo: string
  projects: string[]
  reviewers: string[]
  stagingUrl: string
  serviceName: string
}

export interface FeatureJobInput {
  type: 'feature'
  repo: string
  reviewers: string[]
  description: string
  serviceName: string
}

/**
 * Jira-triggered feature job.
 * The spec-writer agent infers repo/reviewers/description from the ticket.
 */
export interface JiraJobInput {
  type: 'feature'
  jiraTicketId: string
  triggerSource: 'jira'
}

/**
 * File-watcher-triggered self-improvement job.
 * Created automatically when the watcher detects changes to memory/, agents/,
 * or tools/src/ in the a5-ai repo. Tracks the PR that was opened.
 */
export interface SelfUpdateJobInput {
  type: 'self-update'
  prId: number
  repoSlug: string
  branchName: string
  changedFiles: string[]
}

export type JobInput = MigrationJobInput | FeatureJobInput | JiraJobInput | SelfUpdateJobInput

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true if the job is in a state where the runner loop should stop. */
export function isTerminalStatus(status: string): boolean {
  return (
    status === STATUS_COMPLETE ||
    status === STATUS_ESCALATED ||
    status === STATUS_FAILED
  )
}

/** Returns true if the job is currently parked waiting for an external event. */
export function isParkingStatus(status: string): boolean {
  return (
    status === STATUS_AWAITING_PLAN_APPROVAL ||
    status === STATUS_AWAITING_PR_MERGE
  )
}

/** Maps a JobType to its default workflowPath. */
export function defaultWorkflowPath(type: JobType): string {
  switch (type) {
    case JobType.Migration:  return 'workflows/migration/workflow.md'
    case JobType.Feature:    return 'workflows/feature/workflow.md'
    case JobType.SelfUpdate: return ''  // handled inline by the watcher
  }
}
