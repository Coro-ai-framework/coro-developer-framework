// ── Review coordinator ───────────────────────────────────────────────────────
//
// The only component that decides *when* a round runs. Agents decide what
// the round does. Rounds are ordinary jobs; this state machine never parks
// one. It debounces, coalesces, and short-circuits before any model call.

import {
  isCoroReviewBody,
  type FindingStatus,
  type PrReview,
  type ReviewEvent,
  type ReviewRoundSummary,
  type ReviewShortCircuit,
  type RoundKind,
} from '@coro-ai/cloud-protocol'
import { commandIsAuthorised, parseReviewCommand } from './commands'
import { reviewIdFor } from './id'
import type { ReviewPolicy } from './policy'
import type { ReviewStore } from './store'

export interface RoundDispatch {
  jobId: string
}

export interface ShortCircuitDecision {
  kind: ReviewShortCircuit
  headSha?: string
  summary: string
}

export interface ReviewCoordinatorDeps {
  store: ReviewStore
  policy: ReviewPolicy
  reviewerLogin: string
  identityMode?: 'self' | 'bot'
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => { clear: () => void }
  dispatchRound: (review: PrReview, kind: RoundKind, events: ReviewEvent[]) => Promise<RoundDispatch>
  /** Optional. Returning a decision records a zero-cost round instead of dispatching. */
  assess?: (review: PrReview, kind: RoundKind, events: ReviewEvent[]) => Promise<ShortCircuitDecision | null>
  /** UTC-day spend across every review, for the daily budget. */
  spendTodayUsd?: () => Promise<number>
  log?: (msg: string, extra?: Record<string, unknown>) => void
}

const KIND_RANK: Record<RoundKind, number> = {
  initial: 0,
  conversation: 1,
  incremental: 2,
  command: 3,
  rerequest: 4,
  closing: 5,
}

export class ReviewCoordinator {
  private readonly timers = new Map<string, { clear: () => void }>()
  private readonly running = new Set<string>()
  private readonly deps: ReviewCoordinatorDeps

  constructor(deps: ReviewCoordinatorDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private log(msg: string, extra?: Record<string, unknown>): void {
    this.deps.log?.(msg, extra)
  }

  async ingest(event: ReviewEvent): Promise<PrReview | null> {
    if (this.isSelfEvent(event)) return null

    const login = this.deps.reviewerLogin || 'unknown'
    const id = reviewIdFor(event.prRef, login)
    let review = await this.deps.store.get(id)

    if (!review) {
      if (event.kind !== 'review-requested' && event.kind !== 'manual') return null
      if (!this.passesFilters(event)) return null
      review = this.blank(id, event, login)
      await this.deps.store.save(review)
    }

    if (review.status === 'done' && event.kind !== 'reopened' && event.kind !== 'review-requested' && event.kind !== 'manual') {
      return review
    }

    if (await this.applyLifecycle(review, event)) {
      await this.deps.store.save(review)
      return review
    }

    review.pendingEvents.push(event)
    review.updatedAt = new Date(this.now()).toISOString()
    if (review.status === 'paused' && review.pauseReason === 'user') {
      await this.deps.store.save(review)
      return review
    }
    if (review.status !== 'running') review.status = 'queued'
    await this.deps.store.save(review)
    this.schedule(review.id, delayFor(review.pendingEvents, this.deps.policy.debounceSec))
    return review
  }

  async onRoundStopped(job: {
    id: string
    status: string
    type?: string
    params?: Record<string, unknown>
    tokenUsage?: { totalCostUsd?: number; inputTokens?: number; outputTokens?: number }
  }): Promise<void> {
    const reviewId = typeof job.params?.['reviewId'] === 'string' ? job.params['reviewId'] : undefined
    if (!reviewId) return
    const review = await this.deps.store.get(reviewId)
    if (!review) return
    this.running.delete(review.id)

    const failed = job.status === 'failed' || job.status === 'escalated'
    const round = review.rounds.find(item => item.jobId === job.id)
    const cost = job.tokenUsage?.totalCostUsd ?? 0
    if (round && !round.endedAt) {
      round.endedAt = new Date(this.now()).toISOString()
      round.outcome = failed ? 'failed' : round.outcome
      round.costUsd = cost
    }
    review.totals.costUsd += cost
    review.totals.inputTokens += job.tokenUsage?.inputTokens ?? 0
    review.totals.outputTokens += job.tokenUsage?.outputTokens ?? 0
    this.addDailySpend(review, cost)

    if (failed) {
      const attempts = Number(job.params?.['roundAttempt'] ?? 1)
      if (attempts < 2 && review.pendingEvents.length === 0) {
        review.status = 'queued'
        review.pendingEvents.push({
          kind: 'command',
          prRef: review.prRef,
          at: new Date(this.now()).toISOString(),
          data: { command: 'review', retry: true },
          source: 'manual',
        })
      } else {
        review.status = 'failed'
      }
    } else if (review.pendingVerdict) {
      review.status = 'awaiting-verdict'
    } else if (review.pr.state !== 'open') {
      review.status = 'done'
    } else {
      review.status = review.pendingEvents.length > 0 ? 'queued' : 'idle'
    }
    review.updatedAt = new Date(this.now()).toISOString()
    await this.deps.store.save(review)
    if (review.pendingEvents.length > 0 && review.status === 'queued') {
      this.schedule(review.id, delayFor(review.pendingEvents, this.deps.policy.debounceSec))
    }
  }

  /** Reviews left `running` across a restart are reconciled from their job. */
  async reconcileRunning(jobStatus: (jobId: string) => Promise<string | null>): Promise<void> {
    const running = await this.deps.store.list({ status: 'running' })
    for (const review of running) {
      const latest = review.rounds[review.rounds.length - 1]
      if (!latest) {
        review.status = 'queued'
        await this.deps.store.save(review)
        continue
      }
      const status = await jobStatus(latest.jobId)
      if (!status || status === 'complete' || status === 'failed' || status === 'cancelled' || status === 'escalated') {
        await this.onRoundStopped({
          id: latest.jobId,
          status: status ?? 'failed',
          params: { reviewId: review.id },
        })
      } else {
        this.running.add(review.id)
      }
    }
  }

  async pause(id: string): Promise<PrReview | null> {
    const review = await this.deps.store.get(id)
    if (!review) return null
    review.status = 'paused'
    review.pauseReason = 'user'
    review.updatedAt = new Date(this.now()).toISOString()
    this.timers.get(id)?.clear()
    this.timers.delete(id)
    await this.deps.store.save(review)
    return review
  }

  async resume(id: string): Promise<PrReview | null> {
    const review = await this.deps.store.get(id)
    if (!review) return null
    review.pauseReason = undefined
    review.status = review.pendingEvents.length > 0 ? 'queued' : 'idle'
    review.updatedAt = new Date(this.now()).toISOString()
    await this.deps.store.save(review)
    if (review.pendingEvents.length > 0) {
      this.schedule(review.id, delayFor(review.pendingEvents, this.deps.policy.debounceSec))
    }
    return review
  }

  private schedule(id: string, delayMs = this.deps.policy.debounceSec * 1000): void {
    if (this.running.has(id)) return
    this.timers.get(id)?.clear()
    const delay = delayMs
    const setTimer = this.deps.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms)
      return { clear: () => clearTimeout(handle) }
    })
    const timer = setTimer(() => {
      this.timers.delete(id)
      void this.fire(id)
    }, delay)
    this.timers.set(id, timer)
  }

  private async fire(id: string): Promise<void> {
    if (this.running.size >= this.deps.policy.maxConcurrentRounds) {
      this.schedule(id, 5_000)
      return
    }
    const review = await this.deps.store.get(id)
    if (!review || review.pendingEvents.length === 0) return
    if (review.status === 'paused' || review.status === 'running' || review.status === 'done') return
    if (review.totals.rounds >= this.deps.policy.maxRounds) {
      review.status = 'paused'
      review.pauseReason = 'max-rounds'
      await this.deps.store.save(review)
      return
    }
    if (review.totals.costUsd >= this.deps.policy.budgetUsdPerPr) {
      review.status = 'paused'
      review.pauseReason = 'budget'
      await this.deps.store.save(review)
      return
    }
    const today = await this.deps.spendTodayUsd?.() ?? 0
    if (today >= this.deps.policy.budgetUsdPerDay) {
      review.status = 'paused'
      review.pauseReason = 'budget'
      await this.deps.store.save(review)
      return
    }

    const events = review.pendingEvents.splice(0, review.pendingEvents.length)
    const kind = classifyRoundKind(review, events)
    const decision = await this.deps.assess?.(review, kind, events) ?? null
    if (decision) {
      this.recordShortCircuit(review, kind, decision)
      await this.deps.store.save(review)
      if (review.pendingEvents.length > 0) {
        this.schedule(review.id, delayFor(review.pendingEvents, this.deps.policy.debounceSec))
      }
      return
    }

    review.status = 'running'
    review.updatedAt = new Date(this.now()).toISOString()
    const placeholder: ReviewRoundSummary = {
      round: review.totals.rounds + 1,
      jobId: '',
      kind,
      headSha: review.pr.headSha,
      startedAt: new Date(this.now()).toISOString(),
      outcome: 'no-op',
      summary: '',
      costUsd: 0,
    }
    review.rounds.push(placeholder)
    review.totals.rounds += 1
    await this.deps.store.save(review)

    try {
      const dispatched = await this.deps.dispatchRound(review, kind, events)
      placeholder.jobId = dispatched.jobId
      this.running.add(review.id)
      await this.deps.store.save(review)
    } catch (err) {
      placeholder.outcome = 'failed'
      placeholder.endedAt = new Date(this.now()).toISOString()
      placeholder.summary = err instanceof Error ? err.message : String(err)
      review.status = 'failed'
      await this.deps.store.save(review)
    }
  }

  private recordShortCircuit(review: PrReview, kind: RoundKind, decision: ShortCircuitDecision): void {
    review.rounds.push({
      round: review.totals.rounds + 1,
      jobId: '',
      kind,
      headSha: decision.headSha ?? review.pr.headSha,
      startedAt: new Date(this.now()).toISOString(),
      endedAt: new Date(this.now()).toISOString(),
      outcome: 'no-op',
      summary: decision.summary,
      costUsd: 0,
      shortCircuit: decision.kind,
    })
    review.totals.rounds += 1
    if (decision.headSha) {
      review.pr.headSha = decision.headSha
      review.ledger.lastReviewedSha = decision.headSha
    }
    review.status = review.pr.state === 'open' ? 'idle' : 'done'
    review.updatedAt = new Date(this.now()).toISOString()
    this.log('review short-circuit', { reviewId: review.id, kind: decision.kind })
  }

  private async applyLifecycle(review: PrReview, event: ReviewEvent): Promise<boolean> {
    if (event.kind === 'merged' || event.kind === 'closed') {
      review.pr.state = event.kind === 'merged' ? 'merged' : 'declined'
      if (this.deps.policy.learnOnClose === 'off') {
        review.status = 'done'
        return true
      }
      if (this.deps.policy.learnOnClose === 'deterministic') {
        applyDeterministicClose(review)
        review.status = 'done'
        review.rounds.push({
          round: review.totals.rounds + 1,
          jobId: '',
          kind: 'closing',
          headSha: review.pr.headSha,
          startedAt: new Date(this.now()).toISOString(),
          endedAt: new Date(this.now()).toISOString(),
          outcome: 'no-op',
          summary: 'Closed from thread state without a model call.',
          costUsd: 0,
          shortCircuit: 'deterministic-close',
        })
        review.totals.rounds += 1
        return true
      }
      return false
    }
    if (event.kind === 'reopened') {
      review.pr.state = 'open'
      review.status = 'idle'
      return true
    }
    if (event.kind === 'converted-to-draft' && this.deps.policy.skipDrafts) {
      review.pr.draft = true
      review.status = 'paused'
      review.pauseReason = 'draft'
      return true
    }
    if (event.kind === 'ready-for-review') {
      review.pr.draft = false
      if (review.pauseReason === 'draft') review.pauseReason = undefined
      return false
    }
    if (event.kind === 'review-request-removed') {
      const openThreads = review.ledger.findings.some(f => f.status === 'open' && f.threadId)
      if (!openThreads) {
        review.status = 'paused'
        review.pauseReason = 'review-request-removed'
        return true
      }
    }
    if (event.kind === 'comment' || event.kind === 'command') {
      const body = typeof event.data['body'] === 'string' ? event.data['body'] : undefined
      const command = parseReviewCommand(body) ?? (event.kind === 'command'
        ? { name: String(event.data['command'] ?? '') as 'review', arg: undefined }
        : null)
      if (!command || !command.name) return false
      if (event.kind === 'comment' && !commandIsAuthorised(event.actor, review.pr.author, review.reviewer.login)) {
        return false
      }
      if (command.name === 'pause') {
        review.status = 'paused'
        review.pauseReason = 'user'
        return true
      }
      if (command.name === 'resume') {
        review.pauseReason = undefined
        review.status = 'queued'
        review.pendingEvents.push({ ...event, kind: 'command', data: { ...event.data, command: 'review' } })
        this.schedule(review.id, delayFor(review.pendingEvents, this.deps.policy.debounceSec))
        return true
      }
      if (command.name === 'ignore' && command.arg) {
        const finding = review.ledger.findings.find(f => f.id === command.arg)
        if (finding) {
          finding.status = 'withdrawn'
          finding.lastTouchedRound = review.totals.rounds
        }
        return true
      }
    }
    return false
  }

  private isSelfEvent(event: ReviewEvent): boolean {
    const body = typeof event.data['body'] === 'string' ? event.data['body'] : undefined
    return isCoroReviewBody(body)
  }

  private passesFilters(event: ReviewEvent): boolean {
    const repo = event.prRef.repoKey ?? ''
    if (this.deps.policy.reposInclude.length > 0 && !this.deps.policy.reposInclude.includes(repo)) return false
    if (this.deps.policy.reposExclude.includes(repo)) return false
    const author = typeof event.data['author'] === 'string' ? event.data['author'] : ''
    if (author && this.deps.policy.skipAuthors.includes(author)) return false
    if (event.data['draft'] === true && this.deps.policy.skipDrafts) return false
    return true
  }

  private blank(id: string, event: ReviewEvent, login: string): PrReview {
    const now = new Date(this.now()).toISOString()
    return {
      id,
      prRef: event.prRef,
      reviewer: { login, mode: this.deps.identityMode ?? this.deps.policy.identity },
      status: 'queued',
      pr: {
        title: String(event.data['title'] ?? ''),
        author: String(event.data['author'] ?? ''),
        baseSha: String(event.data['baseSha'] ?? ''),
        headSha: String(event.data['headSha'] ?? ''),
        state: 'open',
        draft: event.data['draft'] === true,
        url: event.prRef.url ?? '',
      },
      ledger: { findings: [] },
      rounds: [],
      pendingEvents: [],
      totals: { rounds: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 },
      createdAt: now,
      updatedAt: now,
    }
  }

  private addDailySpend(review: PrReview, usd: number): void {
    const day = new Date(this.now()).toISOString().slice(0, 10)
    if (!review.spendDay || review.spendDay.day !== day) review.spendDay = { day, usd: 0 }
    review.spendDay.usd += usd
  }
}

export function classifyRoundKind(review: PrReview, events: ReviewEvent[]): RoundKind {
  let best: RoundKind = review.totals.rounds === 0 ? 'initial' : 'conversation'
  for (const event of events) {
    const kind = eventToKind(event, review)
    if (KIND_RANK[kind] > KIND_RANK[best]) best = kind
  }
  return best
}

function delayFor(events: ReviewEvent[], debounceSec: number): number {
  if (events.some(event => event.kind === 'commits-pushed' || event.kind === 'review-requested')) {
    return debounceSec * 1000
  }
  return 30_000
}

function eventToKind(event: ReviewEvent, review: PrReview): RoundKind {
  if (event.kind === 'review-requested' && review.totals.rounds > 0) return 'rerequest'
  if (event.kind === 'review-requested' || event.kind === 'manual') return 'initial'
  if (event.kind === 'commits-pushed' || event.kind === 'ready-for-review') return 'incremental'
  if (event.kind === 'merged' || event.kind === 'closed') return 'closing'
  if (event.kind === 'command') return 'command'
  return 'conversation'
}

function applyDeterministicClose(review: PrReview): void {
  for (const finding of review.ledger.findings) {
    if (finding.status !== 'open') continue
    const status: FindingStatus = finding.threadId ? 'addressed' : 'outdated'
    finding.status = status
    finding.lastTouchedRound = review.totals.rounds + 1
  }
}

/** Comments that do not mention Coro and are not replies to a Coro thread. */
export function isIrrelevantConversation(review: PrReview, events: ReviewEvent[]): boolean {
  if (events.length === 0) return false
  if (events.some(event => event.kind !== 'comment' && event.kind !== 'review-submitted')) return false
  return events.every(event => {
    const body = typeof event.data['body'] === 'string' ? event.data['body'] : ''
    if (/@coro\b/i.test(body)) return false
    const threadId = typeof event.data['threadId'] === 'string' ? event.data['threadId'] : undefined
    if (threadId && review.ledger.findings.some(f => f.threadId === threadId)) return false
    return true
  })
}
