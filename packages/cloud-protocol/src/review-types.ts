// ── PR review wire types ─────────────────────────────────────────────────────
//
// A Review is one continuous review of a pull request. Rounds are ordinary
// jobs; this record is the durable state they read and write. Shared so the
// runner, the dashboard, and a headless CI marker can agree on the shape.

import type { ExternalRef } from './refs'

export type ReviewStatus =
  | 'queued'
  | 'running'
  | 'idle'
  | 'awaiting-verdict'
  | 'paused'
  | 'done'
  | 'failed'

export type RoundKind =
  | 'initial'
  | 'incremental'
  | 'conversation'
  | 'rerequest'
  | 'command'
  | 'closing'

export type FindingSeverity = 'blocker' | 'major' | 'minor' | 'nit'

export type FindingCategory =
  | 'correctness'
  | 'security'
  | 'tests'
  | 'design'
  | 'architecture'
  | 'contract'
  | 'performance'
  | 'style'
  | 'other'

export type FindingStatus = 'open' | 'addressed' | 'declined' | 'outdated' | 'withdrawn'

export type ReviewVerdict = 'approve' | 'request_changes' | 'comment'

export type ReviewEventKind =
  | 'review-requested'
  | 'review-request-removed'
  | 'commits-pushed'
  | 'comment'
  | 'review-submitted'
  | 'thread-resolved'
  | 'ready-for-review'
  | 'converted-to-draft'
  | 'merged'
  | 'closed'
  | 'reopened'
  | 'command'
  | 'manual'

export type ReviewEventSource = 'inbox-poll' | 'activity-poll' | 'ci' | 'webhook' | 'manual'

export type ReviewShortCircuit =
  | 'patch-unchanged'
  | 'irrelevant-conversation'
  | 'out-of-scope'
  | 'deterministic-close'

export interface FindingSource {
  kind: 'code' | 'adr' | 'catalog' | 'doc' | 'checker' | 'memory'
  ref: string
}

export interface Finding {
  id: string
  fingerprint: string
  severity: FindingSeverity
  category: FindingCategory
  lens: string
  path?: string
  line?: number
  side?: 'LEFT' | 'RIGHT'
  title: string
  body?: string
  status: FindingStatus
  threadId?: string
  commentId?: string
  sources?: FindingSource[]
  raisedInRound: number
  lastTouchedRound: number
}

export interface ReviewLedger {
  lastReviewedSha?: string
  /** Per-file patch-id of the PR diff last reviewed. Rebase-only pushes match. */
  patchIds?: Record<string, string>
  findings: Finding[]
  pendingReviewId?: string
}

export interface ReviewEvent {
  kind: ReviewEventKind
  prRef: ExternalRef
  actor?: string
  at: string
  data: Record<string, unknown>
  source: ReviewEventSource
}

export interface ReviewRoundSummary {
  round: number
  jobId: string
  kind: RoundKind
  headSha: string
  startedAt: string
  endedAt?: string
  outcome: 'submitted' | 'replied' | 'no-op' | 'held-for-verdict' | 'failed'
  verdict?: ReviewVerdict
  summary: string
  costUsd: number
  lensCosts?: Record<string, { costUsd: number; inputTokens: number; outputTokens: number; findings: number }>
  shortCircuit?: ReviewShortCircuit
}

export interface PendingVerdict {
  verdict: ReviewVerdict
  body: string
  /** SCM pending-review id when the provider supports draft reviews. */
  pendingReviewId?: string
  heldAt: string
}

export interface ArchitectureBrief {
  service?: string
  owners?: string[]
  dependsOn?: string[]
  consumers?: string[]
  adrs?: { id: string; title: string; ref: string }[]
  contractFiles: string[]
  sources: { kind: string; ref: string; readAt: string; baseSha?: string }[]
  builtInRound: number
  builtAt: string
}

export interface PrReview {
  id: string
  prRef: ExternalRef
  reviewer: { login: string; mode: 'self' | 'bot' }
  status: ReviewStatus
  pauseReason?: 'user' | 'budget' | 'max-rounds' | 'review-request-removed' | 'draft'
  pr: {
    title: string
    author: string
    baseSha: string
    headSha: string
    state: 'open' | 'merged' | 'declined'
    draft: boolean
    url: string
  }
  ledger: ReviewLedger
  rounds: ReviewRoundSummary[]
  pendingEvents: ReviewEvent[]
  pendingVerdict?: PendingVerdict
  architectureBrief?: ArchitectureBrief
  totals: { rounds: number; costUsd: number; inputTokens: number; outputTokens: number }
  /** Spend attributed today (UTC), so a daily budget survives restarts. */
  spendDay?: { day: string; usd: number }
  createdAt: string
  updatedAt: string
}

export const PR_REVIEW_WORKFLOW_PATH = 'workflows/pr-review/workflow.md'

/** Hidden marker on every Coro-authored comment. Self-events are filtered on it. */
export const REVIEW_MARKER_PREFIX = '<!-- coro-review:'

export function reviewMarker(reviewId: string, findingId?: string): string {
  return findingId
    ? `<!-- coro-review:${reviewId}:${findingId} -->`
    : `<!-- coro-review:${reviewId} -->`
}

export function isCoroReviewBody(body: string | undefined | null): boolean {
  return typeof body === 'string' && body.includes(REVIEW_MARKER_PREFIX)
}
