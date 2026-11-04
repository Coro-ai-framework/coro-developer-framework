import { formatPreciseCurrency } from './format'
import { jsonRequest, requestJson } from './http'
import type { Tone } from './status'

export type ReviewStatus =
  | 'queued'
  | 'running'
  | 'idle'
  | 'awaiting-verdict'
  | 'paused'
  | 'done'
  | 'failed'
  | 'skipped'

export type FindingSeverity = 'blocker' | 'major' | 'minor' | 'nit'
export type FindingStatus = 'open' | 'addressed' | 'declined' | 'outdated' | 'withdrawn'
export type ReviewVerdict = 'approve' | 'request_changes' | 'comment'
export type PauseReason = 'user' | 'budget' | 'max-rounds' | 'review-request-removed' | 'draft'

export interface ReviewFinding {
  id: string
  severity: FindingSeverity
  category: string
  lens: string
  path?: string
  line?: number
  title: string
  body?: string
  status: FindingStatus
  commentId?: string
  raisedInRound: number
  lastTouchedRound: number
}

export interface ReviewRound {
  round: number
  jobId: string
  kind: string
  headSha: string
  startedAt: string
  endedAt?: string
  outcome: 'submitted' | 'replied' | 'no-op' | 'held-for-verdict' | 'failed' | 'stopped'
  verdict?: ReviewVerdict
  summary: string
  costUsd: number
  lensCosts?: Record<string, { costUsd: number; inputTokens: number; outputTokens: number; findings: number }>
  shortCircuit?: 'patch-unchanged' | 'irrelevant-conversation' | 'out-of-scope' | 'deterministic-close'
}

export interface ReviewPendingEvent {
  kind: string
  at: string
  actor?: string
  source: string
}

export interface PrReview {
  id: string
  prRef: { pluginId: string; repoKey?: string; externalId: string; url?: string }
  reviewer: { login: string; mode: 'self' | 'bot' }
  status: ReviewStatus
  pauseReason?: PauseReason
  pr: {
    title: string
    author: string
    baseSha: string
    headSha: string
    state: 'open' | 'merged' | 'declined'
    draft: boolean
    url: string
    changedFiles?: number
    additions?: number
    deletions?: number
    labels?: string[]
  }
  lastError?: string
  ledger: { lastReviewedSha?: string; findings: ReviewFinding[] }
  rounds: ReviewRound[]
  pendingEvents: ReviewPendingEvent[]
  pendingVerdict?: {
    verdict: ReviewVerdict
    body: string
    heldAt: string
    /** Set when the provider holds Coro's comments in a draft review only you can see. */
    pendingReviewId?: string
    /** Set when the provider has no drafts and Coro posted nothing yet. */
    heldComments?: Array<{ path: string; line: number; body: string }>
  }
  totals: { rounds: number; costUsd: number; inputTokens: number; outputTokens: number }
  spendDay?: { day: string; usd: number }
  /** Present while a round is scheduled; set by the runner, not stored. */
  nextRoundAt?: string
  /** Present while the round's draft waits for you before anything is posted; set by the runner. */
  awaitingApproval?: { jobId: string; since: string }
  createdAt: string
  updatedAt: string
}

export interface ReviewEngineStatus {
  enabled: boolean
  running: boolean
  login?: string
  identity?: 'self' | 'bot'
  eventSource?: 'poll' | 'webhook' | 'both'
  scms: string[]
  inboxIntervalSec?: number
  inbox?: { lastPollAt?: string; lastError?: string; openRequests: number; unsupported: string[] }
  startedAt?: string
}

export interface ReviewsSettings {
  enabled?: boolean
  identity?: 'self' | 'bot'
  eventSource?: 'poll' | 'webhook' | 'both'
  autonomy?: 'draft' | 'comment' | 'full'
  approval?: 'never' | 'recommend' | 'auto'
  approveBeforePosting?: boolean
  minSeverity?: FindingSeverity
  skipDrafts?: boolean
  budgetUsdPerPr?: number
  budgetUsdPerDay?: number
  maxRounds?: number
  debounceSec?: number
  inbox?: { intervalSec?: number; includeTeams?: boolean }
  [key: string]: unknown
}

export const REVIEWS_PATH = '/reviews'
export const REVIEW_SETTINGS_PATH = '/settings#pr-reviews'

export const SEVERITY_ORDER: FindingSeverity[] = ['blocker', 'major', 'minor', 'nit']

export const SEVERITY_TONE: Record<FindingSeverity, Tone> = {
  blocker: 'danger',
  major: 'warning',
  minor: 'accent',
  nit: 'neutral',
}

export const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  approve: 'Approve',
  request_changes: 'Request changes',
  comment: 'Comment',
}

const PAUSE_REASON: Record<PauseReason, string> = {
  user: 'Paused by you',
  budget: 'Budget reached',
  'max-rounds': 'Round limit reached',
  'review-request-removed': 'Review request removed',
  draft: 'Pull request is a draft',
}

const ROUND_KIND: Record<string, string> = {
  initial: 'First review',
  incremental: 'New commits',
  conversation: 'Conversation',
  rerequest: 'Full re-review',
  command: 'Command',
  closing: 'Closing notes',
}

const ROUND_OUTCOME: Record<ReviewRound['outcome'], { label: string; tone: Tone }> = {
  submitted: { label: 'Posted', tone: 'success' },
  replied: { label: 'Replied', tone: 'success' },
  'no-op': { label: 'Nothing to add', tone: 'neutral' },
  'held-for-verdict': { label: 'Verdict held', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  stopped: { label: 'Stopped', tone: 'neutral' },
}

const SHORT_CIRCUIT: Record<NonNullable<ReviewRound['shortCircuit']>, string> = {
  'patch-unchanged': 'Rebase only, no model run',
  'irrelevant-conversation': 'Not about the review, no model run',
  'out-of-scope': 'Nothing reviewable changed, no model run',
  'deterministic-close': 'Closed without a model run',
}

export interface ReviewStatusMeta {
  label: string
  tone: Tone
  pulse?: boolean
  detail?: string
}

export function reviewStatusMeta(review: PrReview): ReviewStatusMeta {
  switch (review.status) {
    case 'queued':
      return { label: 'Queued', tone: 'accent', detail: review.nextRoundAt ? `Starts ${formatUntil(review.nextRoundAt)}` : 'Starting soon' }
    case 'running':
      if (review.awaitingApproval) return { label: 'Needs approval', tone: 'warning', pulse: true, detail: 'Draft ready to post' }
      return { label: 'Reviewing', tone: 'accent', pulse: true, detail: roundKindLabel(latestRound(review)?.kind) }
    case 'idle':
      return { label: 'Watching', tone: 'success', detail: review.rounds.length ? 'Up to date' : 'Waiting for a round' }
    case 'awaiting-verdict':
      return {
        label: 'Needs verdict',
        tone: 'warning',
        pulse: true,
        detail: review.pendingVerdict ? `Recommends ${VERDICT_LABEL[review.pendingVerdict.verdict].toLowerCase()}` : undefined,
      }
    case 'paused':
      return { label: 'Paused', tone: 'warning', detail: review.pauseReason ? PAUSE_REASON[review.pauseReason] : undefined }
    case 'skipped':
      return { label: 'Skipped', tone: 'neutral', detail: 'Coro leaves this PR alone' }
    case 'failed':
      return { label: 'Failed', tone: 'danger', detail: review.lastError ? 'See the error' : undefined }
    case 'done':
      return { label: review.pr.state === 'merged' ? 'Merged' : 'Closed', tone: 'neutral', detail: 'No more rounds' }
  }
}

export function pauseReasonLabel(reason: PauseReason | undefined): string | undefined {
  return reason ? PAUSE_REASON[reason] : undefined
}

export function roundKindLabel(kind: string | undefined): string | undefined {
  return kind ? ROUND_KIND[kind] ?? kind : undefined
}

export function roundOutcomeMeta(round: ReviewRound): { label: string; tone: Tone; pulse?: boolean } {
  if (!round.endedAt) return { label: round.jobId ? 'In progress' : 'Preparing', tone: 'accent', pulse: true }
  return ROUND_OUTCOME[round.outcome]
}

export function shortCircuitLabel(round: ReviewRound): string | undefined {
  return round.shortCircuit ? SHORT_CIRCUIT[round.shortCircuit] : undefined
}

export function latestRound(review: PrReview): ReviewRound | undefined {
  return review.rounds[review.rounds.length - 1]
}

export function prNumberLabel(review: PrReview): string {
  return `${review.prRef.repoKey ?? review.prRef.pluginId}#${review.prRef.externalId}`
}

export function scmLabel(pluginId: string): string {
  if (pluginId === 'github') return 'GitHub'
  if (pluginId === 'gitlab') return 'GitLab'
  if (pluginId === 'bitbucket') return 'Bitbucket'
  return pluginId
}

export function openFindings(review: PrReview): ReviewFinding[] {
  return review.ledger.findings.filter(finding => finding.status === 'open')
}

export function countBySeverity(findings: ReviewFinding[]): Record<FindingSeverity, number> {
  const counts: Record<FindingSeverity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 }
  for (const finding of findings) counts[finding.severity] += 1
  return counts
}

export function needsAttention(review: PrReview): boolean {
  if (review.awaitingApproval || review.pendingVerdict || review.status === 'awaiting-verdict' || review.status === 'failed') return true
  return review.status === 'paused' && review.pauseReason !== undefined && review.pauseReason !== 'user'
}

export function isActiveReview(review: PrReview): boolean {
  return review.status === 'queued' || (review.status === 'running' && !review.awaitingApproval)
}

/** A decision only the developer can make: a draft to approve or a verdict to submit. */
export function awaitsDecision(review: PrReview): boolean {
  return Boolean(review.awaitingApproval || review.pendingVerdict)
}

export function runHref(jobId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}`
}

/** A link to the finding's line. GitHub only; other SCMs open the PR. */
export function findingHref(review: PrReview, finding: ReviewFinding): string | undefined {
  if (!finding.path) return review.pr.url || undefined
  if (review.prRef.pluginId === 'github' && review.prRef.repoKey && review.pr.headSha) {
    const line = finding.line ? `#L${finding.line}` : ''
    return `https://github.com/${review.prRef.repoKey}/blob/${review.pr.headSha}/${finding.path}${line}`
  }
  return review.pr.url || undefined
}

export function commitHref(review: PrReview, sha: string): string | undefined {
  if (!sha) return undefined
  if (review.prRef.pluginId === 'github' && review.prRef.repoKey) return `https://github.com/${review.prRef.repoKey}/commit/${sha}`
  return undefined
}

/** Review spend: `$0.00` for nothing spent, cents precision below a cent otherwise. */
export function formatReviewCost(usd: number | undefined): string {
  if (!usd) return '$0.00'
  return formatPreciseCurrency(usd)
}

export function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : '—'
}

export function roundDurationMs(round: ReviewRound): number | null {
  if (!round.endedAt) return Date.now() - Date.parse(round.startedAt)
  return Date.parse(round.endedAt) - Date.parse(round.startedAt)
}

function formatUntil(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 1000))
  if (seconds < 5) return 'now'
  if (seconds < 90) return `in ${seconds}s`
  return `in ${Math.round(seconds / 60)} min`
}

export type ReviewControl = 'pause' | 'resume' | 'stop' | 'skip' | 'rerun'

export function reviewControl(id: string, action: ReviewControl): Promise<PrReview> {
  return requestJson<PrReview>(`${REVIEWS_PATH}/${encodeURIComponent(id)}/${action}`, { method: 'POST' })
}

export function startReview(prUrl: string): Promise<PrReview> {
  return requestJson<PrReview>(REVIEWS_PATH, jsonRequest({ prUrl }, { method: 'POST' }))
}

export function deleteReview(id: string): Promise<void> {
  return requestJson<void>(`${REVIEWS_PATH}/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function updateFinding(id: string, findingId: string, status: FindingStatus): Promise<PrReview> {
  return requestJson<PrReview>(
    `${REVIEWS_PATH}/${encodeURIComponent(id)}/findings/${encodeURIComponent(findingId)}`,
    jsonRequest({ status }, { method: 'PATCH' }),
  )
}

export function sendVerdict(
  id: string,
  action: 'submit' | 'edit' | 'discard',
  draft?: { body: string; event: ReviewVerdict },
): Promise<PrReview> {
  return requestJson<PrReview>(
    `${REVIEWS_PATH}/${encodeURIComponent(id)}/verdict`,
    jsonRequest({ action, ...draft }, { method: 'POST' }),
  )
}

export function pollInbox(): Promise<ReviewEngineStatus> {
  return requestJson<ReviewEngineStatus>(`${REVIEWS_PATH}/inbox/poll`, { method: 'POST' })
}

/** Which controls make sense for a review in its current state. */
export function availableControls(review: PrReview) {
  const closed = review.status === 'done'
  return {
    rerun: !closed && review.status !== 'running',
    pause: !closed && review.status !== 'paused' && review.status !== 'skipped',
    resume: review.status === 'paused',
    stop: review.status === 'running',
    skip: !closed && review.status !== 'skipped',
  }
}
