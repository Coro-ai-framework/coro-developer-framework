// ── Job taxonomy ─────────────────────────────────────────────────────────────

/**
 * The type of work a job performs.
 * Determines which workflowPath is used and which phases are valid.
 */
export enum JobType {
  Job        = 'job',
  SelfUpdate = 'self-update',
}

// ── Well-known statuses ──────────────────────────────────────────────────────

export const STATUS_QUEUED                      = 'queued'
export const STATUS_COMPLETE                    = 'complete'
export const STATUS_CANCELLED                   = 'cancelled'
export const STATUS_ESCALATED                   = 'escalated'
export const STATUS_FAILED                      = 'failed'
export const STATUS_AWAITING_PLAN_APPROVAL      = 'awaiting-plan-approval'
export const STATUS_AWAITING_PR_MERGE           = 'awaiting-pr-merge'
export const STATUS_AWAITING_DEVELOPER_INPUT    = 'awaiting-developer-input'
/**
 * Campaign job status while parked in `coordinating`. The dispatcher's
 * child-completion hook resumes the parent out of this status once every
 * child reaches a terminal state.
 */
export const STATUS_AWAITING_CHILDREN           = 'awaiting-children'
export const STATUS_CODING                      = 'coding'

// ── PR tracking ───────────────────────────────────────────────────────────────

export interface PrMapping {
  prId: number
  workItem: string
  repoSlug: string
  openedAt: string
  mergedAt?: string
}

// ── Work-item tracking ────────────────────────────────────────────────────────

export interface WorkItem {
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
  /**
   * Set when this insight was inherited from an earlier sibling in the
   * same campaign. The dispatcher tags every insight it carries from a
   * completed child onto a freshly-dispatched sibling so the agent can
   * tell its own findings apart from upstream ones in the prompt.
   * Empty / undefined for insights produced by the current job.
   */
  sourceChildName?: string
}

// ── Campaign coordination ────────────────────────────────────────────────────
//
// A campaign is just a Job whose workflowPath is the campaign workflow.
// The campaign-planner registers child specs on `Job.campaignChildren[]`;
// the dispatcher's coordinator hook spawns each one as a normal Job and
// links it back via `Job.campaignParentId`. No new JobType, no new table.

/**
 * Where a campaign child issue lives in the chosen tracker.
 * Optional — children created mid-campaign without a tracker round-trip
 * still execute; the tracker is system-of-record but not on the critical
 * path. `provider` is informational; the runner picks the actual client
 * via `settings.tracker.provider`.
 */
export interface TrackerRef {
  provider: 'jira' | 'github' | 'linear'
  key: string
  url: string
}

/** Lifecycle of a single child within its campaign. */
export type CampaignChildStatus =
  | 'pending'         // registered, dependencies not yet satisfied
  | 'ready'           // dependencies satisfied, awaiting dispatcher slot
  | 'dispatched'      // child Job has been created and is running / parked
  | 'complete'        // child Job reached complete
  | 'failed'          // child Job failed
  | 'escalated'       // child Job escalated to human
  | 'skipped'         // human or evaluator skipped this child

/**
 * Spec for a single child of a campaign. Authored by the campaign-planner
 * via `campaign_register_child`. The dispatcher uses this as the seed for
 * a normal Job when dependencies are satisfied.
 */
export interface CampaignChild {
  /** Unique within the campaign — used as the dependsOn key. */
  name: string
  /** Free-form description handed to the child's planner. */
  description: string
  /**
   * Seed `params` for the dispatched child Job. The dispatcher merges in
   * `epicAllowed: false` and `campaignParentId: <parent>` before creation.
   */
  params: Record<string, unknown>
  /** Names of other children this one is blocked on. */
  dependsOn: string[]
  /** Tracker issue key/url, if the planner created one. */
  trackerRef?: TrackerRef
  /** Job id once dispatched. */
  jobId?: string
  status: CampaignChildStatus
  /** When the child Job was first dispatched. */
  startedAt?: string
  /** When the child Job reached a terminal status. */
  completedAt?: string
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
  currentWorkItem: string | null

  /** Populated by planning via set_work_items. The runner does not act on these. */
  workItems: WorkItem[]
  /** Current work-item loop count — denormalized from workItems[] for quick access. */
  workItemLoopCount: number

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

  /**
   * Set by the dispatcher when a developer replies to an interactive
   * checkpoint park. Its value is the phase the developer had the option to
   * advance to (i.e., the former `awaitingNextPhase`).
   *
   * The runner consumes this on the next turn: if the agent finishes that
   * turn with the job still on the phase it was parked in, the runner skips
   * the "park for approval after {phase}" check for that one transition —
   * otherwise the job loops forever (agent calls `goto_phase` because the
   * framed prompt told it to, runner parks again because the phase still
   * has `interactive_checkpoint: true`). The field is cleared as soon as
   * the phase advances, so a subsequent natural phase end re-arms the
   * checkpoint.
   */
  approvedAdvanceFromPhase?: string

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

  /**
   * Children registered by the campaign-planner via `campaign_register_child`.
   * Present only on campaign jobs (whose workflowPath is the campaign
   * workflow). Authoritative source of dependency edges between issues.
   */
  campaignChildren?: CampaignChild[]

  /**
   * Back-pointer from a child Job to its owning campaign Job. Set by the
   * dispatcher when a campaign child is spawned. Used by webhook resolvers,
   * the dashboard, and the coordinator hook to find the parent on
   * child-stopped transitions.
   */
  campaignParentId?: string

  /**
   * Insights collected from completed campaign children, kept on the parent
   * campaign job. The dispatcher appends to this list every time a child
   * reaches a terminal status, then seeds freshly-dispatched siblings with
   * its contents (via {@link JobInput.initialInsights}) so each new child
   * inherits everything earlier siblings learned. Each entry has its
   * `sourceChildName` set to the originating child. The full PR-merge-pull
   * memory cycle still runs at campaign end via the campaign-evaluator —
   * this aggregator is the *in-flight* mechanism that lets sibling N+1
   * benefit from sibling N's discoveries before any human review happens.
   */
  campaignAggregatedInsights?: Insight[]
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
  type?: 'job' | 'self-update'
  workflowPath?: string
  triggerSource?: 'cli' | 'jira' | 'internal'
  params: Record<string, unknown>
  /**
   * Optional seed for the new job's `insights` array. Today the only
   * caller setting this is the campaign dispatcher, which forwards the
   * parent's `campaignAggregatedInsights` so a freshly-dispatched sibling
   * can read what earlier siblings learned without waiting on the
   * campaign-evaluator's PR-merge cycle. Empty / undefined means start
   * with no insights, as before.
   */
  initialInsights?: Insight[]
}

// ── Proposals ─────────────────────────────────────────────────────────────────

// Proposal types map to specific writable file locations in the
// intelligence stack — see the `self-improvement-guide` skill in
// `@coro/intelligence-base` for the canonical mapping.
//
// `source-change` was removed when the legacy `tools/src/**/*.ts`
// layout disappeared with the monorepo conversion. Runner source
// changes are out-of-band today; agents should use a regular code PR
// rather than `propose_change`.
export type ProposalType =
  | 'new-tool'
  | 'modify-tool'
  | 'new-workflow'
  | 'modify-workflow'
  | 'new-agent'
  | 'modify-agent'
  | 'memory-update'
  | 'skill-create'
  | 'skill-update'
  | 'claude-md-update'

export type ProposalStatus = 'pending' | 'approved' | 'rejected'

/**
 * Where a proposal lands.
 *   - `tenant` — the tenant intelligence repo (same mechanism for solo and team).
 *   - `repo`   — the active job's target repo, under `.coro/`.
 *   - The base layer is never writable.
 */
export type ProposalTargetLayer = 'tenant' | 'repo'

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
  /**
   * Layer the proposal was shipped to. Optional so legacy proposals
   * predating the layered model continue to load cleanly.
   */
  targetLayer?: ProposalTargetLayer
  /** Branch name in the target repo. */
  branch?: string
  /** Web URL of the opened PR (`null` if PR opening was skipped/failed). */
  prUrl?: string | null
  /** Provider-specific PR id. */
  prId?: number | null
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
  return status === STATUS_COMPLETE || status === STATUS_CANCELLED
}

/**
 * Has the runner stopped processing this job?
 * Includes terminal (complete, cancelled) and stopped-with-reason
 * (failed, escalated).
 * Used by SSE to close the log stream — no more logs will be produced until
 * a manual resume. Distinct from isParkingStatus (which covers awaiting-*
 * states where the stream may stay open for webhook-driven resume).
 */
export function isStoppedStatus(status: string): boolean {
  return (
    status === STATUS_COMPLETE ||
    status === STATUS_CANCELLED ||
    status === STATUS_FAILED ||
    status === STATUS_ESCALATED
  )
}

/**
 * Can this job be woken up by an external event?
 * Includes explicit parking states AND escalated/failed — because a webhook
 * event (comment, approval, merge) may provide exactly the context the agent
 * needs to continue. The AI decides whether to proceed or re-escalate.
 * Terminal statuses (`complete`, `cancelled`) are unreachable.
 */
export function isParkingStatus(status: string): boolean {
  return (
    status === STATUS_AWAITING_PLAN_APPROVAL ||
    status === STATUS_AWAITING_PR_MERGE ||
    status === STATUS_AWAITING_DEVELOPER_INPUT ||
    status === STATUS_AWAITING_CHILDREN ||
    status === STATUS_ESCALATED ||
    status === STATUS_FAILED
  )
}

/**
 * Whether a job can be resumed manually or via a control-plane event.
 * Failed/escalated stay resumable so developers can continue after review;
 * cancelled is intentionally terminal and excluded. The runner also uses
 * workflow phase names (for example `planning`) as live statuses, so every
 * non-terminal state remains resumable subject to the dispatcher's active-run
 * concurrency checks.
 */
export function isResumableStatus(status: string): boolean {
  return !isTerminalStatus(status)
}

/**
 * Whether the job can still be cancelled.
 * Completed work is immutable; every other lifecycle state remains cancellable.
 */
export function isCancellableStatus(status: string): boolean {
  return !isTerminalStatus(status)
}

/**
 * Canonical state mutation applied when a job is cancelled.
 * Callers may layer additional volatile cleanup (such as in-memory event
 * queues) on top, but the persisted lifecycle fields should stay aligned.
 */
export function cancelledJobPatch(): Partial<Job> {
  return {
    status: STATUS_CANCELLED,
    awaitingEvent: undefined,
    awaitingPrId: undefined,
    awaitingNextPhase: undefined,
    approvedAdvanceFromPhase: undefined,
    pendingPrompt: undefined,
    escalationMessage: undefined,
  }
}

export function defaultWorkflowPath(type: JobType): string {
  switch (type) {
    case JobType.Job:        return 'workflows/job/workflow.md'
    case JobType.SelfUpdate: return 'workflows/self-update/workflow.md'
  }
}

/**
 * Canonical path for the campaign workflow. The planner switches a job's
 * `workflowPath` to this value via `convert_to_campaign`. Tenants override
 * the workflow file itself through the layered intelligence resolver.
 */
export const CAMPAIGN_WORKFLOW_PATH = 'workflows/campaign/workflow.md'

// ── Campaign helpers ──────────────────────────────────────────────────────────

/**
 * A job is a campaign job iff it has a `campaignChildren` array on it.
 * We deliberately do NOT key off `workflowPath` so a tenant that renames
 * the campaign workflow file still gets correctly classified.
 */
export function isCampaignJob(job: Job): boolean {
  return Array.isArray(job.campaignChildren)
}

/**
 * Whether `convert_to_campaign` is permitted on this job. Children are
 * dispatched with `params.epicAllowed = false` to prevent recursive
 * decomposition (a child becoming its own campaign).
 */
export function isEpicAllowed(job: Job): boolean {
  return job.params['epicAllowed'] !== false
}

/** Terminal child statuses — coordinator stops dispatching once all are terminal. */
export function isTerminalChildStatus(status: CampaignChildStatus): boolean {
  return (
    status === 'complete' ||
    status === 'failed' ||
    status === 'escalated' ||
    status === 'skipped'
  )
}

/** Status of a child considered "satisfied" for dependency resolution. */
export function isSatisfiedChildStatus(status: CampaignChildStatus): boolean {
  return status === 'complete' || status === 'skipped'
}
