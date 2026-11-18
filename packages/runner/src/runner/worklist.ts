// ── Work list ────────────────────────────────────────────────────────────────
//
// Projects conversations, runs and reviews into the dashboard's sidebar. The
// grouping rules live here, once, so the sidebar, the needs-you count and the
// desktop badge cannot disagree.
//
// The sidebar polls every few seconds, and the records behind it are not
// small: a plan-mode transcript is routinely hundreds of kilobytes and a job
// carries its artefacts. `WorklistService` therefore keeps a projection per
// record keyed by its `updatedAt` and, when the backend can list versions
// cheaply, re-reads only what changed.

import {
  PAUSED_AWAITING_EVENT,
  STATUS_AWAITING_DEVELOPER_INPUT,
  STATUS_AWAITING_PLAN_APPROVAL,
  STATUS_CANCELLED,
  STATUS_COMPLETE,
  STATUS_ESCALATED,
  STATUS_FAILED,
  WORKLIST_RECENT_CONVERSATIONS,
  WORKLIST_RECENT_REVIEWS,
  WORKLIST_RECENT_RUNS,
  WORKLIST_STALE_CONVERSATION_MS,
  INVESTIGATION_LIST_MAX_LIMIT,
  type InvestigationSummary,
  type Job,
  type PrReview,
  type WorkAttentionReason,
  type WorkConversation,
  type WorkGroup,
  type WorkReview,
  type WorkRun,
  type Worklist,
} from '@coro-ai/cloud-protocol'
import type { RecordVersion, StateBackend } from '../state/backend'
import { toInvestigationSummary } from '../state/investigation'

export interface Grouping {
  group: WorkGroup
  attention: WorkAttentionReason | null
}

const ESCALATION_MAX_CHARS = 280

// ── Grouping rules ───────────────────────────────────────────────────────────

export function groupRun(job: Pick<Job, 'status' | 'awaitingEvent'>): Grouping {
  switch (job.status) {
    case STATUS_ESCALATED:
      return { group: 'needs-you', attention: 'escalated' }
    case STATUS_FAILED:
      return { group: 'needs-you', attention: 'failed' }
    case STATUS_AWAITING_PLAN_APPROVAL:
      return { group: 'needs-you', attention: 'plan-approval' }
    case STATUS_AWAITING_DEVELOPER_INPUT:
      // A developer pause is the developer's own hold, not a question for them.
      return job.awaitingEvent === PAUSED_AWAITING_EVENT
        ? { group: 'waiting', attention: null }
        : { group: 'needs-you', attention: 'input' }
    case STATUS_COMPLETE:
    case STATUS_CANCELLED:
      return { group: 'recent', attention: null }
    default:
      // Workflows declare their own phase statuses, so anything unknown is a
      // running phase; the parked set is closed and always `awaiting-*`.
      return job.status.startsWith('awaiting-')
        ? { group: 'waiting', attention: null }
        : { group: 'working', attention: null }
  }
}

export function groupConversation(
  conversation: Pick<WorkConversation, 'status' | 'updatedAt'>,
  live: { streaming: boolean; pendingPermissions: number },
  now: number,
): Grouping {
  if (live.pendingPermissions > 0) return { group: 'needs-you', attention: 'permission' }
  if (live.streaming) return { group: 'working', attention: null }
  if (conversation.status !== 'active') return { group: 'recent', attention: null }
  const age = now - Date.parse(conversation.updatedAt)
  return age < WORKLIST_STALE_CONVERSATION_MS
    ? { group: 'waiting', attention: null }
    : { group: 'recent', attention: null }
}

export function groupReview(
  review: Pick<PrReview, 'status' | 'pauseReason' | 'pendingVerdict'>,
  awaitingApprovalJobId: string | undefined,
): Grouping {
  if (awaitingApprovalJobId) return { group: 'needs-you', attention: 'review-draft' }
  if (review.pendingVerdict || review.status === 'awaiting-verdict') {
    return { group: 'needs-you', attention: 'review-verdict' }
  }
  switch (review.status) {
    case 'failed':
      return { group: 'needs-you', attention: 'review-failed' }
    case 'paused':
      // Budget and round limits stop a review until someone raises them. A
      // draft PR or a removed request resolves itself on the author's side.
      return review.pauseReason === 'budget' || review.pauseReason === 'max-rounds'
        ? { group: 'needs-you', attention: 'review-held' }
        : { group: 'waiting', attention: null }
    case 'queued':
    case 'running':
      return { group: 'working', attention: null }
    case 'idle':
      return { group: 'waiting', attention: null }
    default:
      return { group: 'recent', attention: null }
  }
}

// ── Projections ──────────────────────────────────────────────────────────────

function param(job: Pick<Job, 'params'>, key: string): string | undefined {
  const value = job.params?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function runTitle(job: Pick<Job, 'id' | 'type' | 'params'>): string {
  return param(job, 'serviceName')
    ?? param(job, 'campaignChildName')
    ?? param(job, 'jiraTicketId')
    ?? (job.type === 'retrospective' ? 'Retrospective' : undefined)
    ?? (job.type === 'self-update' ? 'Self-update' : undefined)
    ?? job.id
}

export function projectRun(job: Job): WorkRun {
  const investigationId = param(job, 'investigationId')
  const escalation = job.escalationMessage?.trim()
  return {
    kind: 'run',
    id: job.id,
    type: job.type,
    workflowPath: job.workflowPath,
    title: runTitle(job),
    repo: param(job, 'repoSlug') ?? param(job, 'repo') ?? null,
    status: job.status,
    phase: job.phase,
    ...(job.awaitingEvent ? { awaitingEvent: job.awaitingEvent } : {}),
    ...(escalation ? { escalationMessage: escalation.slice(0, ESCALATION_MAX_CHARS) } : {}),
    currentWorkItem: job.currentWorkItem ?? null,
    interactive: Boolean(job.interactive),
    ...(investigationId ? { investigationId } : {}),
    ...(job.campaignParentId ? { campaignParentId: job.campaignParentId } : {}),
    costUsd: job.tokenUsage?.totalCostUsd ?? 0,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...groupRun(job),
  }
}

/** The part of a conversation that only changes when its record does. */
export type ConversationBase = Omit<WorkConversation, 'streaming' | 'pendingPermissions' | 'group' | 'attention'>

export function conversationBase(summary: InvestigationSummary): ConversationBase {
  const readiness = summary.readiness
  return {
    kind: 'conversation',
    id: summary.id,
    title: summary.title,
    status: summary.status,
    readinessState: readiness?.state ?? null,
    openQuestions: readiness?.openQuestions?.length ?? 0,
    reviewIds: summary.reviewIds ?? [],
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  }
}

export function projectConversation(
  base: ConversationBase,
  live: { streaming: boolean; pendingPermissions: number },
  now: number,
): WorkConversation {
  return { ...base, ...live, ...groupConversation(base, live, now) }
}

export function reviewPrLabel(review: Pick<PrReview, 'prRef'>): string {
  return `${review.prRef.repoKey ?? review.prRef.pluginId}#${review.prRef.externalId}`
}

export function projectReview(review: PrReview, awaitingApprovalJobId: string | undefined): WorkReview {
  const openFindings = { blocker: 0, major: 0, minor: 0, nit: 0 }
  for (const finding of review.ledger?.findings ?? []) {
    if (finding.status === 'open' && finding.severity in openFindings) openFindings[finding.severity] += 1
  }
  const prLabel = reviewPrLabel(review)
  return {
    kind: 'review',
    id: review.id,
    title: review.pr?.title?.trim() || prLabel,
    prLabel,
    prUrl: review.pr?.url || review.prRef.url || '',
    scm: review.prRef.pluginId,
    prState: review.pr?.state ?? 'open',
    status: review.status,
    ...(review.pauseReason ? { pauseReason: review.pauseReason } : {}),
    ...(awaitingApprovalJobId ? { awaitingApprovalJobId } : {}),
    ...(review.pendingVerdict ? { pendingVerdict: review.pendingVerdict.verdict } : {}),
    ...(review.lastError ? { lastError: review.lastError.slice(0, ESCALATION_MAX_CHARS) } : {}),
    openFindings,
    rounds: review.totals?.rounds ?? review.rounds?.length ?? 0,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
    ...groupReview(review, awaitingApprovalJobId),
  }
}

/**
 * The round job whose draft is parked for approval. Mirrors the server's
 * `reviewWithSchedule` projection, but reads job status from what the work
 * list already loaded instead of fetching per review.
 */
export function awaitingApprovalJobId(
  review: Pick<PrReview, 'status' | 'rounds'>,
  jobStatus: (jobId: string) => string | undefined,
): string | undefined {
  if (review.status !== 'running') return undefined
  const latest = review.rounds?.[review.rounds.length - 1]
  if (!latest?.jobId || latest.endedAt) return undefined
  return jobStatus(latest.jobId) === STATUS_AWAITING_DEVELOPER_INPUT ? latest.jobId : undefined
}

// ── Assembly ─────────────────────────────────────────────────────────────────

function newestFirst<T extends { updatedAt: string }>(a: T, b: T): number {
  return b.updatedAt.localeCompare(a.updatedAt)
}

function keepRecent<T extends { id: string; group: WorkGroup; updatedAt: string }>(items: T[], cap: number): Set<string> {
  const kept = new Set<string>()
  let recent = 0
  for (const item of [...items].sort(newestFirst)) {
    if (item.group !== 'recent') kept.add(item.id)
    else if (recent < cap) {
      kept.add(item.id)
      recent += 1
    }
  }
  return kept
}

/**
 * Applies the recent caps, then completes every thread: a live run pulls in
 * the conversation or campaign that started it, and every kept parent keeps
 * all of its children. The sidebar can then nest without holes.
 */
export function assembleWorklist(input: {
  conversations: WorkConversation[]
  runs: WorkRun[]
  reviews: WorkReview[]
}, pinnedKeys: ReadonlySet<string> = new Set()): Worklist {
  const runsById = new Map(input.runs.map(run => [run.id, run]))
  const conversationsById = new Map(input.conversations.map(c => [c.id, c]))
  const reviewsById = new Map(input.reviews.map(r => [r.id, r]))

  const keptConversations = keepRecent(input.conversations, WORKLIST_RECENT_CONVERSATIONS)
  const keptRuns = keepRecent(input.runs, WORKLIST_RECENT_RUNS)
  const keptReviews = keepRecent(input.reviews, WORKLIST_RECENT_REVIEWS)
  for (const conversation of input.conversations) {
    if (pinnedKeys.has(`conversation:${conversation.id}`)) keptConversations.add(conversation.id)
  }
  for (const run of input.runs) {
    if (pinnedKeys.has(`run:${run.id}`)) keptRuns.add(run.id)
  }
  for (const review of input.reviews) {
    if (pinnedKeys.has(`review:${review.id}`)) keptReviews.add(review.id)
  }

  // Upward: a kept run keeps its parent run and its conversation.
  const pending = [...keptRuns]
  while (pending.length > 0) {
    const run = runsById.get(pending.pop()!)
    if (!run) continue
    if (run.campaignParentId && runsById.has(run.campaignParentId) && !keptRuns.has(run.campaignParentId)) {
      keptRuns.add(run.campaignParentId)
      pending.push(run.campaignParentId)
    }
    if (run.investigationId && conversationsById.has(run.investigationId)) {
      keptConversations.add(run.investigationId)
    }
  }
  // A kept review keeps the conversation that started it.
  for (const conversation of input.conversations) {
    if (conversation.reviewIds.some(id => keptReviews.has(id))) keptConversations.add(conversation.id)
  }

  // Downward: a kept conversation or run keeps all of its children.
  for (const conversation of input.conversations) {
    if (!keptConversations.has(conversation.id)) continue
    for (const id of conversation.reviewIds) if (reviewsById.has(id)) keptReviews.add(id)
  }
  let grew = true
  while (grew) {
    grew = false
    for (const run of input.runs) {
      if (keptRuns.has(run.id)) continue
      const parentKept = run.campaignParentId
        ? keptRuns.has(run.campaignParentId)
        : Boolean(run.investigationId && keptConversations.has(run.investigationId))
      if (parentKept) {
        keptRuns.add(run.id)
        grew = true
      }
    }
  }

  const conversations = input.conversations.filter(c => keptConversations.has(c.id)).sort(newestFirst)
  const runs = input.runs.filter(r => keptRuns.has(r.id)).sort(newestFirst)
  const reviews = input.reviews.filter(r => keptReviews.has(r.id)).sort(newestFirst)
  const needsYou = [...conversations, ...runs, ...reviews].filter(item => item.group === 'needs-you').length
  return { needsYou, conversations, runs, reviews }
}

// ── Service ──────────────────────────────────────────────────────────────────

export interface WorklistLiveState {
  /** A plan-mode turn is in flight for this conversation. */
  streaming(conversationId: string): boolean
  pendingPermissions(conversationId: string): number
}

interface CachedJob {
  updatedAt: string
  status: string
  /** `null` for job types the work list does not show (review rounds). */
  run: WorkRun | null
}

interface CachedConversation {
  updatedAt: string
  base: ConversationBase
}

type WorklistInput = Parameters<typeof assembleWorklist>[0]

/** Re-read a row this recent even when its version looks unchanged; two writes can share a millisecond. */
const FRESH_WRITE_WINDOW_MS = 10_000
/** Above this many changed rows a single list is cheaper than one read per row. */
const BULK_READ_THRESHOLD = 20
/** Polls that arrive together share one build. */
const RESULT_TTL_MS = 750

export class WorklistService {
  private readonly jobs = new Map<string, CachedJob>()
  private readonly conversations = new Map<string, CachedConversation>()
  private inflight: Promise<WorklistInput> | null = null
  private last: { at: number; value: WorklistInput } | null = null

  constructor(
    private readonly stateBackend: StateBackend,
    private readonly live: WorklistLiveState,
    private readonly clock: () => number = Date.now,
  ) {}

  async get(pinnedKeys: ReadonlySet<string> = new Set()): Promise<Worklist> {
    const now = this.clock()
    if (this.last && now - this.last.at < RESULT_TTL_MS) return assembleWorklist(this.last.value, pinnedKeys)
    if (this.inflight) return assembleWorklist(await this.inflight, pinnedKeys)
    this.inflight = this.build()
      .then(value => {
        this.last = { at: this.clock(), value }
        return value
      })
      .finally(() => {
        this.inflight = null
      })
    return assembleWorklist(await this.inflight, pinnedKeys)
  }

  private async build(): Promise<WorklistInput> {
    const now = this.clock()
    const versions = this.stateBackend.listRecordVersions
      ? await this.stateBackend.listRecordVersions()
      : null

    if (versions) {
      await this.refreshJobs(versions.jobs, now)
      await this.refreshConversations(versions.investigations, now)
    } else {
      this.replaceJobs(await this.stateBackend.listJobs())
      this.replaceConversations(await this.listAllInvestigations())
    }

    const reviews = await this.stateBackend.reviews.list()
    const jobStatus = (id: string) => this.jobs.get(id)?.status
    const runs = [...this.jobs.values()].flatMap(entry => (entry.run ? [entry.run] : []))
    const conversations = [...this.conversations.values()].map(entry =>
      projectConversation(
        entry.base,
        {
          streaming: this.live.streaming(entry.base.id),
          pendingPermissions: this.live.pendingPermissions(entry.base.id),
        },
        now,
      ),
    )
    return {
      conversations,
      runs,
      reviews: reviews.map(review => projectReview(review, awaitingApprovalJobId(review, jobStatus))),
    }
  }

  private stale(cachedAt: string | undefined, version: RecordVersion, now: number): boolean {
    if (cachedAt !== version.updatedAt) return true
    return now - Date.parse(version.updatedAt) < FRESH_WRITE_WINDOW_MS
  }

  private async refreshJobs(versions: RecordVersion[], now: number): Promise<void> {
    const seen = new Set(versions.map(v => v.id))
    for (const id of this.jobs.keys()) if (!seen.has(id)) this.jobs.delete(id)
    const changed = versions.filter(v => this.stale(this.jobs.get(v.id)?.updatedAt, v, now))
    if (changed.length === 0) return
    if (changed.length > BULK_READ_THRESHOLD) {
      this.replaceJobs(await this.stateBackend.listJobs())
      return
    }
    for (const { id } of changed) {
      const job = await this.stateBackend.getJob(id)
      if (job) this.cacheJob(job)
      else this.jobs.delete(id)
    }
  }

  private async refreshConversations(versions: RecordVersion[], now: number): Promise<void> {
    const seen = new Set(versions.map(v => v.id))
    for (const id of this.conversations.keys()) if (!seen.has(id)) this.conversations.delete(id)
    const changed = versions.filter(v => this.stale(this.conversations.get(v.id)?.updatedAt, v, now))
    if (changed.length === 0) return
    if (changed.length > BULK_READ_THRESHOLD) {
      this.replaceConversations(await this.listAllInvestigations())
      return
    }
    for (const { id } of changed) {
      const record = await this.stateBackend.getInvestigation(id)
      if (record) this.cacheConversation(toInvestigationSummary(record))
      else this.conversations.delete(id)
    }
  }

  private replaceJobs(jobs: Job[]): void {
    this.jobs.clear()
    for (const job of jobs) this.cacheJob(job)
  }

  private replaceConversations(summaries: InvestigationSummary[]): void {
    this.conversations.clear()
    for (const summary of summaries) this.cacheConversation(summary)
  }

  private cacheJob(job: Job): void {
    this.jobs.set(job.id, {
      updatedAt: job.updatedAt,
      status: job.status,
      run: job.type === 'pr-review' ? null : projectRun(job),
    })
  }

  private cacheConversation(summary: InvestigationSummary): void {
    this.conversations.set(summary.id, { updatedAt: summary.updatedAt, base: conversationBase(summary) })
  }

  private async listAllInvestigations(): Promise<InvestigationSummary[]> {
    const all: InvestigationSummary[] = []
    for (let offset = 0; ; offset += INVESTIGATION_LIST_MAX_LIMIT) {
      const page = await this.stateBackend.listInvestigations({ limit: INVESTIGATION_LIST_MAX_LIMIT, offset })
      all.push(...page.sessions)
      if (page.sessions.length < INVESTIGATION_LIST_MAX_LIMIT || all.length >= page.total) return all
    }
  }
}
