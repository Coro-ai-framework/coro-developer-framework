// ── Job runtime helpers ──────────────────────────────────────────────────────
//
// Pure functions that operate on the wire-level `Job` shape from
// `@coro-ai/cloud-protocol`. They live runner-side because they bake in
// runner-specific lifecycle semantics (parking/cancellation rules,
// workflow path defaults) that the cloud control plane and plugin SDK
// should not import.
//
// Anything that mutates server-side state belongs in the dispatcher /
// state backend; this file only constructs `Partial<Job>` patches and
// returns booleans / accessors.

import {
  JobType,
  PAUSED_AWAITING_EVENT,
  STATUS_AWAITING_CHILDREN,
  STATUS_AWAITING_DEVELOPER_INPUT,
  STATUS_AWAITING_PLAN_APPROVAL,
  STATUS_AWAITING_PR_MERGE,
  STATUS_AWAITING_RATE_LIMIT,
  STATUS_CANCELLED,
  STATUS_COMPLETE,
  STATUS_ESCALATED,
  STATUS_FAILED,
  type CampaignChildStatus,
  type Job,
  type TokenUsage,
} from '@coro-ai/cloud-protocol'

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

// ── Status predicates ─────────────────────────────────────────────────────────

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
    status === STATUS_AWAITING_RATE_LIMIT ||
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

// ── Patch builders ────────────────────────────────────────────────────────────

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

/**
 * Canonical state mutation applied when a developer pauses a running job
 * from the dashboard. Parks the job in `awaiting-developer-input` with a
 * marker `awaitingEvent` so the existing send-message-to-resume path
 * works unchanged. The dashboard reads the marker to render a "Paused"
 * label rather than "Awaiting input".
 */
export function pausedJobPatch(): Partial<Job> {
  return {
    status: STATUS_AWAITING_DEVELOPER_INPUT,
    awaitingEvent: PAUSED_AWAITING_EVENT,
    awaitingPrId: undefined,
    awaitingNextPhase: undefined,
    approvedAdvanceFromPhase: undefined,
    escalationMessage: undefined,
  }
}

// ── Workflow paths ────────────────────────────────────────────────────────────

export function defaultWorkflowPath(type: JobType): string {
  switch (type) {
    case JobType.Job:        return 'workflows/job/workflow.md'
    case JobType.SelfUpdate: return 'workflows/self-update/workflow.md'
  }
}

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
    status === 'skipped' ||
    status === 'cancelled'
  )
}

/** Status of a child considered "satisfied" for dependency resolution. */
export function isSatisfiedChildStatus(status: CampaignChildStatus): boolean {
  return status === 'complete' || status === 'skipped' || status === 'cancelled'
}
