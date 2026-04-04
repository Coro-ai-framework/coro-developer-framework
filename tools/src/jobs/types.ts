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

/**
 * Lifecycle status of a job.
 * Updated by the runner and dispatcher as the job progresses.
 */
export enum JobStatus {
  Queued               = 'queued',
  Initializing         = 'initializing',
  SpecWriting          = 'spec-writing',         // feature (Jira) only
  Analyzing            = 'analyzing',            // migration only
  Planning             = 'planning',
  AwaitingPlanApproval = 'awaiting-plan-approval',
  RepoSetup            = 'repo-setup',           // migration only
  Coding               = 'coding',
  AwaitingPrMerge      = 'awaiting-pr-merge',
  Testing              = 'testing',
  Evaluating           = 'evaluating',
  Reporting            = 'reporting',
  Complete             = 'complete',
  Escalated            = 'escalated',
  Failed               = 'failed',
}

/**
 * The current phase within a workflow.
 * Each phase maps to a specific agent MD file loaded by the prompt builder.
 */
export enum JobPhase {
  Init        = 'init',
  SpecWriting = 'spec-writing',  // agents/spec-writer.md
  Analysis    = 'analysis',      // agents/analyzer.md
  Planning    = 'planning',      // agents/planner.md
  RepoSetup   = 'repo-setup',    // agents/coder.md
  Coding      = 'coding',        // agents/coder.md
  Review      = 'review',        // agents/pr-reviewer.md
  Testing     = 'testing',       // agents/tester.md
  Evaluation  = 'evaluation',    // agents/evaluator.md
  Reporting   = 'reporting',     // agents/planner.md (summary role)
}

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
  status: JobStatus
  phase: JobPhase
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

export type JobInput = MigrationJobInput | FeatureJobInput | JiraJobInput

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true if the job is in a state where the runner loop should stop. */
export function isTerminalStatus(status: JobStatus): boolean {
  return (
    status === JobStatus.Complete ||
    status === JobStatus.Escalated ||
    status === JobStatus.Failed
  )
}

/** Returns true if the job is currently parked waiting for an external event. */
export function isParkingStatus(status: JobStatus): boolean {
  return (
    status === JobStatus.AwaitingPlanApproval ||
    status === JobStatus.AwaitingPrMerge
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
