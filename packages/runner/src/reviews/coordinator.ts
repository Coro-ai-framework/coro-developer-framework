// ── Review coordinator ───────────────────────────────────────────────────────
//
// The only component that decides *when* a round runs. Agents decide what
// the round does. Rounds are ordinary jobs; this state machine never parks
// one. It debounces, coalesces, and short-circuits before any model call.
//
// Every read-modify-write of a review goes through `locked()`. Preparing a
// round makes network calls, so `fire` claims the round under the lock,
// works outside it, then re-reads the review before writing. Without that,
// an event ingested while the diff was being fetched would be overwritten.

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
  /**
   * Optional. Runs before dispatch, outside the lock. May refresh
   * `review.pr` from the SCM. Returning a decision records a zero-cost
   * round instead of dispatching.
   */
  assess?: (review: PrReview, kind: RoundKind, events: ReviewEvent[]) => Promise<ShortCircuitDecision | null>
  /**
   * True while a round's job waits for a developer to approve its draft.
   * Such a round costs nothing, so it does not hold a concurrency slot.
   */
  isRoundParked?: (jobId: string) => Promise<boolean>
  /** Cancels a round's job. Without it, stop only pauses future rounds. */
  cancelRound?: (jobId: string) => Promise<void>
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

/** A review in one of these states already has, or is about to have, a round. */
const BUSY = new Set<PrReview['status']>(['queued', 'running', 'awaiting-verdict'])

export class ReviewCoordinator {
  private readonly timers = new Map<string, { clear: () => void }>()
  private readonly dueAt = new Map<string, number>()
  private readonly running = new Set<string>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly deps: ReviewCoordinatorDeps

  constructor(deps: ReviewCoordinatorDeps) {
    this.deps = deps
  }

  /** Clears pending timers. Queued reviews stay queued for the next engine's `resumeQueued`. */
  dispose(): void {
    for (const timer of this.timers.values()) timer.clear()
    this.timers.clear()
    this.dueAt.clear()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  private log(msg: string, extra?: Record<string, unknown>): void {
    this.deps.log?.(msg, extra)
  }

  private locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(fn)
    this.locks.set(id, next)
    void next.finally(() => {
      if (this.locks.get(id) === next) this.locks.delete(id)
    }).catch(() => undefined)
    return next
  }

  ingest(event: ReviewEvent): Promise<PrReview | null> {
    if (this.isSelfEvent(event)) return Promise.resolve(null)
    const login = this.deps.reviewerLogin || 'unknown'
    const id = reviewIdFor(event.prRef, login)
    return this.locked(id, () => this.ingestLocked(id, login, event))
  }

  private async ingestLocked(id: string, login: string, event: ReviewEvent): Promise<PrReview | null> {
    const manual = event.kind === 'manual'
    let review = await this.deps.store.get(id)

    if (!review) {
      if (event.kind !== 'review-requested' && !manual) return null
      if (!manual && !this.passesFilters(event)) return null
      review = this.blank(id, event, login)
      await this.deps.store.save(review)
      this.log('review created', { reviewId: id, source: event.source, url: review.pr.url })
    } else if (manual) {
      this.refreshFromEvent(review, event)
    }

    if (review.status === 'skipped' && !manual) return review
    if (review.status === 'done' && event.kind !== 'reopened' && event.kind !== 'review-requested' && !manual) {
      return review
    }
    if (event.kind === 'review-requested' && !manual && this.isDuplicateRequest(review, event)) {
      return review
    }

    if (manual) {
      review.pauseReason = undefined
      review.lastError = undefined
      if (review.status === 'skipped' || review.status === 'paused' || review.status === 'done' || review.status === 'failed') {
        review.status = 'idle'
      }
    }

    if (await this.applyLifecycle(review, event)) {
      review.updatedAt = this.iso()
      await this.deps.store.save(review)
      return review
    }

    review.pendingEvents.push(event)
    review.updatedAt = this.iso()
    if (review.status === 'paused') {
      await this.deps.store.save(review)
      return review
    }
    if (review.status !== 'running') review.status = 'queued'
    await this.deps.store.save(review)
    this.schedule(review.id, delayFor(review.pendingEvents, this.deps.policy.debounceSec))
    return review
  }

  /**
   * The inbox reports every open request on every poll. Only a request
   * that is new to the poller, on a review with nothing in flight, starts
   * a round. Otherwise each poll would reset the debounce timer and the
   * round would never fire.
   */
  private isDuplicateRequest(review: PrReview, event: ReviewEvent): boolean {
    if (BUSY.has(review.status)) return true
    if (review.status === 'paused' && review.pauseReason !== 'review-request-removed') return true
    if (event.data['firstSight'] === true && review.rounds.length > 0) return true
    return false
  }

  onRoundStopped(job: {
    id: string
    status: string
    type?: string
    params?: Record<string, unknown>
    tokenUsage?: { totalCostUsd?: number; inputTokens?: number; outputTokens?: number }
    escalationMessage?: string
    artifacts?: { kind: string; data: unknown }[]
  }): Promise<void> {
    const reviewId = typeof job.params?.['reviewId'] === 'string' ? job.params['reviewId'] : undefined
    if (!reviewId) return Promise.resolve()
    return this.locked(reviewId, () => this.roundStoppedLocked(reviewId, job))
  }

  private async roundStoppedLocked(reviewId: string, job: Parameters<ReviewCoordinator['onRoundStopped']>[0]): Promise<void> {
    const review = await this.deps.store.get(reviewId)
    this.running.delete(reviewId)
    if (!review) return

    const failed = job.status === 'failed' || job.status === 'escalated'
    const cancelled = job.status === 'cancelled'
    const round = review.rounds.find(item => item.jobId === job.id)
    // Already settled: a cancel can be reported by the dispatcher and by the stop fallback.
    if (round?.endedAt) return
    // Lens spend is booked on the job's phase, so the job's usage already
    // includes it; `lensCosts` is only the breakdown.
    const cost = job.tokenUsage?.totalCostUsd ?? 0
    if (round && !round.endedAt) {
      round.endedAt = this.iso()
      if (failed) {
        round.outcome = 'failed'
        if (!round.summary && job.escalationMessage) round.summary = job.escalationMessage
      } else if (cancelled && !round.summary) {
        round.outcome = 'stopped'
        const draft = job.artifacts?.find(item => item.kind === 'review-draft')?.data as { status?: string } | undefined
        round.summary = draft?.status === 'draft'
          ? 'The draft was discarded. Nothing was posted.'
          : 'Stopped before it finished.'
      }
      round.costUsd = cost
    }
    review.totals.costUsd += cost
    review.totals.inputTokens += job.tokenUsage?.inputTokens ?? 0
    review.totals.outputTokens += job.tokenUsage?.outputTokens ?? 0
    this.addDailySpend(review, cost)

    const heldByUser = review.status === 'paused' || review.status === 'skipped'
    if (heldByUser) {
      // A pause or skip that arrived mid-round wins over the round's own result.
    } else if (failed) {
      const attempts = Number(job.params?.['roundAttempt'] ?? 1)
      review.lastError = job.escalationMessage || 'The round failed. Open its run log for details.'
      if (attempts < 2 && review.pendingEvents.length === 0) {
        review.status = 'queued'
        review.pendingEvents.push({
          kind: 'command',
          prRef: review.prRef,
          at: this.iso(),
          data: { command: 'review', retry: true },
          source: 'manual',
        })
      } else {
        review.status = 'failed'
      }
    } else if (review.pendingVerdict) {
      review.status = 'awaiting-verdict'
      review.lastError = undefined
    } else if (review.pr.state !== 'open') {
      review.status = 'done'
    } else {
      review.status = review.pendingEvents.length > 0 ? 'queued' : 'idle'
      if (!cancelled) review.lastError = undefined
    }
    review.updatedAt = this.iso()
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
      if (!latest?.jobId) {
        await this.locked(review.id, async () => {
          const fresh = await this.deps.store.get(review.id)
          if (!fresh) return
          if (latest && !latest.endedAt) {
            latest.endedAt = this.iso()
            latest.outcome = 'stopped'
            latest.summary = 'The runner restarted before this round started.'
            fresh.rounds[fresh.rounds.length - 1] = latest
          }
          fresh.status = fresh.pendingEvents.length > 0 ? 'queued' : 'idle'
          await this.deps.store.save(fresh)
        })
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

  /** Timers live in memory. After a restart, queued reviews need a new one. */
  async resumeQueued(): Promise<void> {
    const queued = await this.deps.store.list({ status: 'queued' })
    for (const review of queued) {
      if (review.pendingEvents.length === 0) {
        await this.locked(review.id, async () => {
          const fresh = await this.deps.store.get(review.id)
          if (!fresh || fresh.status !== 'queued') return
          fresh.status = 'idle'
          await this.deps.store.save(fresh)
        })
        continue
      }
      this.schedule(review.id, delayFor(review.pendingEvents, this.deps.policy.debounceSec))
    }
  }

  /** Earliest time the next round may start, if one is scheduled. */
  nextRoundAt(id: string): number | undefined {
    return this.dueAt.get(id)
  }

  pause(id: string): Promise<PrReview | null> {
    return this.locked(id, async () => {
      const review = await this.deps.store.get(id)
      if (!review) return null
      // A round already in flight finishes; `stop` is the one that cancels it.
      review.status = 'paused'
      review.pauseReason = 'user'
      review.updatedAt = this.iso()
      this.clearTimer(id)
      await this.deps.store.save(review)
      return review
    })
  }

  resume(id: string): Promise<PrReview | null> {
    return this.locked(id, async () => {
      const review = await this.deps.store.get(id)
      if (!review) return null
      if (review.status !== 'paused') return review
      review.pauseReason = undefined
      review.lastError = undefined
      review.status = this.running.has(id) ? 'running' : review.pendingEvents.length > 0 ? 'queued' : 'idle'
      review.updatedAt = this.iso()
      await this.deps.store.save(review)
      if (review.status === 'queued') {
        this.schedule(review.id, delayFor(review.pendingEvents, this.deps.policy.debounceSec))
      }
      return review
    })
  }

  /** Stop the round in flight, if any, and hold further rounds. */
  stop(id: string): Promise<PrReview | null> {
    return this.locked(id, async () => {
      const review = await this.deps.store.get(id)
      if (!review) return null
      await this.cancelInFlight(review)
      review.status = 'paused'
      review.pauseReason = 'user'
      review.updatedAt = this.iso()
      this.clearTimer(id)
      await this.deps.store.save(review)
      return review
    })
  }

  /** Coro leaves this PR alone. Only a manual start brings it back. */
  skip(id: string): Promise<PrReview | null> {
    return this.locked(id, async () => {
      const review = await this.deps.store.get(id)
      if (!review) return null
      await this.cancelInFlight(review)
      review.status = 'skipped'
      review.pauseReason = undefined
      review.pendingEvents = []
      review.updatedAt = this.iso()
      this.clearTimer(id)
      await this.deps.store.save(review)
      return review
    })
  }

  /** A full pass on the current head, now. Clears a pause or a skip. */
  requestRound(id: string): Promise<PrReview | null> {
    return this.locked(id, async () => {
      const review = await this.deps.store.get(id)
      if (!review) return null
      review.pauseReason = undefined
      review.lastError = undefined
      review.pendingEvents.push({
        kind: 'manual',
        prRef: review.prRef,
        at: this.iso(),
        data: { rerun: true },
        source: 'manual',
      })
      if (review.status !== 'running' && review.status !== 'awaiting-verdict') review.status = 'queued'
      review.updatedAt = this.iso()
      await this.deps.store.save(review)
      this.schedule(review.id, 0)
      return review
    })
  }

  /**
   * A read-modify-write from outside the coordinator, under its lock.
   * `fn` returns the review to save, or null to leave it untouched.
   */
  update(id: string, fn: (review: PrReview) => Promise<PrReview | null> | PrReview | null): Promise<PrReview | null> {
    return this.locked(id, async () => {
      const review = await this.deps.store.get(id)
      if (!review) return null
      const next = await fn(review)
      if (!next) return null
      next.updatedAt = this.iso()
      await this.deps.store.save(next)
      return next
    })
  }

  updateFinding(id: string, findingId: string, status: FindingStatus): Promise<PrReview | null> {
    return this.locked(id, async () => {
      const review = await this.deps.store.get(id)
      if (!review) return null
      const finding = review.ledger.findings.find(item => item.id === findingId)
      if (!finding) return null
      finding.status = status
      finding.lastTouchedRound = review.totals.rounds
      review.updatedAt = this.iso()
      await this.deps.store.save(review)
      return review
    })
  }

  remove(id: string): Promise<boolean> {
    return this.locked(id, async () => {
      const review = await this.deps.store.get(id)
      if (!review) return false
      await this.cancelInFlight(review)
      this.clearTimer(id)
      this.running.delete(id)
      await this.deps.store.delete(id)
      return true
    })
  }

  private async cancelInFlight(review: PrReview): Promise<void> {
    if (review.status !== 'running') return
    const latest = review.rounds[review.rounds.length - 1]
    if (!latest || latest.endedAt) return
    if (latest.jobId && this.deps.cancelRound) {
      try {
        await this.deps.cancelRound(latest.jobId)
      } catch (err) {
        this.log('review round cancel failed', { reviewId: review.id, jobId: latest.jobId, err: String(err) })
      }
    }
    if (!latest.jobId) {
      latest.endedAt = this.iso()
      latest.outcome = 'stopped'
      latest.summary = 'Stopped before it started.'
    }
  }

  private clearTimer(id: string): void {
    this.timers.get(id)?.clear()
    this.timers.delete(id)
    this.dueAt.delete(id)
  }

  /**
   * A due round is never pushed later. The window opens at the first
   * event and everything inside it shares the round; resetting it per
   * event would let a busy pull request postpone its round forever.
   */
  private schedule(id: string, delayMs = this.deps.policy.debounceSec * 1000): void {
    if (this.running.has(id)) return
    const due = this.dueAt.get(id)
    if (due !== undefined && this.timers.has(id) && due <= this.now() + delayMs) return
    this.clearTimer(id)
    const setTimer = this.deps.setTimer ?? ((fn, ms) => {
      const handle = setTimeout(fn, ms)
      return { clear: () => clearTimeout(handle) }
    })
    this.dueAt.set(id, this.now() + delayMs)
    const timer = setTimer(() => {
      this.timers.delete(id)
      this.dueAt.delete(id)
      void this.fire(id).catch(err => this.log('review round failed to start', { reviewId: id, err: String(err) }))
    }, delayMs)
    this.timers.set(id, timer)
  }

  private async activeRounds(): Promise<number> {
    if (!this.deps.isRoundParked || this.running.size < this.deps.policy.maxConcurrentRounds) return this.running.size
    let active = 0
    for (const id of this.running) {
      const review = await this.deps.store.get(id)
      const jobId = review?.rounds[review.rounds.length - 1]?.jobId
      if (!jobId || !(await this.deps.isRoundParked(jobId).catch(() => false))) active += 1
    }
    return active
  }

  private async fire(id: string): Promise<void> {
    if (await this.activeRounds() >= this.deps.policy.maxConcurrentRounds) {
      this.schedule(id, 5_000)
      return
    }
    const today = await this.deps.spendTodayUsd?.() ?? 0
    const claim = await this.locked(id, () => this.claimRound(id, today))
    if (!claim) return
    this.running.add(id)
    const { snapshot, kind, events, roundNo } = claim

    let decision: ShortCircuitDecision | null = null
    let prepareError: string | undefined
    try {
      decision = await this.deps.assess?.(snapshot, kind, events) ?? null
    } catch (err) {
      prepareError = err instanceof Error ? err.message : String(err)
    }

    let dispatched: RoundDispatch | undefined
    const proceed = await this.locked(id, async () => {
      const fresh = await this.deps.store.get(id)
      if (!fresh) return false
      fresh.pr = snapshot.pr
      const placeholder = fresh.rounds.find(round => round.round === roundNo && !round.jobId)
      if (fresh.status !== 'running') {
        // Stopped, skipped, or removed while the round was being prepared.
        if (placeholder && !placeholder.endedAt) {
          placeholder.endedAt = this.iso()
          placeholder.outcome = 'stopped'
          placeholder.summary = 'Stopped before it started.'
        }
        await this.deps.store.save(fresh)
        return false
      }
      if (prepareError) {
        this.failPlaceholder(fresh, placeholder, `Could not read the pull request: ${prepareError}`)
        await this.deps.store.save(fresh)
        return false
      }
      if (decision) {
        if (placeholder) fresh.rounds.splice(fresh.rounds.indexOf(placeholder), 1)
        fresh.totals.rounds -= 1
        this.recordShortCircuit(fresh, kind, decision)
        if (fresh.pendingEvents.length > 0) fresh.status = 'queued'
        await this.deps.store.save(fresh)
        if (fresh.status === 'queued') {
          this.running.delete(id)
          this.schedule(id, delayFor(fresh.pendingEvents, this.deps.policy.debounceSec))
        }
        return false
      }
      if (placeholder) placeholder.headSha = fresh.pr.headSha
      await this.deps.store.save(fresh)
      return true
    })
    if (!proceed) {
      this.running.delete(id)
      return
    }

    let dispatchError: string | undefined
    try {
      dispatched = await this.deps.dispatchRound(snapshot, kind, events)
    } catch (err) {
      dispatchError = err instanceof Error ? err.message : String(err)
    }

    await this.locked(id, async () => {
      const fresh = await this.deps.store.get(id)
      if (!fresh) return
      const placeholder = fresh.rounds.find(round => round.round === roundNo && !round.jobId)
      if (dispatched && placeholder) {
        placeholder.jobId = dispatched.jobId
        placeholder.headSha = fresh.pr.headSha
        await this.deps.store.save(fresh)
        // A stop that raced the dispatch still has to reach the new job.
        if (fresh.status !== 'running' && this.deps.cancelRound) {
          await this.deps.cancelRound(dispatched.jobId).catch(() => undefined)
        }
        return
      }
      this.running.delete(id)
      this.failPlaceholder(fresh, placeholder, dispatchError ?? 'The round could not be dispatched.')
      await this.deps.store.save(fresh)
    })
  }

  /** Gate checks and placeholder round, under the lock. */
  private async claimRound(id: string, spendToday: number): Promise<{
    snapshot: PrReview
    kind: RoundKind
    events: ReviewEvent[]
    roundNo: number
  } | null> {
    const review = await this.deps.store.get(id)
    if (!review || review.pendingEvents.length === 0) return null
    if (review.status !== 'queued' && review.status !== 'idle' && review.status !== 'failed') return null
    const policy = this.deps.policy
    const hold = (reason: 'max-rounds' | 'budget', message: string) => {
      review.status = 'paused'
      review.pauseReason = reason
      review.lastError = message
      review.updatedAt = this.iso()
      return this.deps.store.save(review).then(() => null)
    }
    if (review.totals.rounds >= policy.maxRounds) {
      return hold('max-rounds', `Reached the limit of ${policy.maxRounds} rounds for this pull request.`)
    }
    if (review.totals.costUsd >= policy.budgetUsdPerPr) {
      return hold('budget', `Reached the $${policy.budgetUsdPerPr.toFixed(2)} budget for this pull request.`)
    }
    if (spendToday >= policy.budgetUsdPerDay) {
      return hold('budget', `Reached today's $${policy.budgetUsdPerDay.toFixed(2)} review budget.`)
    }

    const events = review.pendingEvents.splice(0, review.pendingEvents.length)
    const kind = classifyRoundKind(review, events)
    const roundNo = review.totals.rounds + 1
    review.status = 'running'
    review.lastError = undefined
    review.updatedAt = this.iso()
    review.rounds.push({
      round: roundNo,
      jobId: '',
      kind,
      headSha: review.pr.headSha,
      startedAt: this.iso(),
      outcome: 'no-op',
      summary: '',
      costUsd: 0,
    })
    review.totals.rounds = roundNo
    await this.deps.store.save(review)
    return { snapshot: structuredClone(review), kind, events, roundNo }
  }

  private failPlaceholder(review: PrReview, placeholder: ReviewRoundSummary | undefined, message: string): void {
    if (placeholder) {
      placeholder.outcome = 'failed'
      placeholder.endedAt = this.iso()
      placeholder.summary = message
    }
    review.lastError = message
    review.status = 'failed'
    review.updatedAt = this.iso()
  }

  private recordShortCircuit(review: PrReview, kind: RoundKind, decision: ShortCircuitDecision): void {
    review.rounds.push({
      round: review.totals.rounds + 1,
      jobId: '',
      kind,
      headSha: decision.headSha ?? review.pr.headSha,
      startedAt: this.iso(),
      endedAt: this.iso(),
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
    review.updatedAt = this.iso()
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
          startedAt: this.iso(),
          endedAt: this.iso(),
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
      if (review.pauseReason === 'draft') {
        review.pauseReason = undefined
        review.status = 'idle'
      }
      return false
    }
    if (event.kind === 'review-request-removed') {
      const openThreads = review.ledger.findings.some(f => f.status === 'open' && (f.threadId || f.commentId))
      if (!openThreads) {
        review.status = 'paused'
        review.pauseReason = 'review-request-removed'
        return true
      }
    }
    if (event.kind === 'review-requested' && review.pauseReason === 'review-request-removed') {
      review.pauseReason = undefined
      review.status = 'idle'
      return false
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
        this.clearTimer(review.id)
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

  /** A manual start may carry fresher PR facts than the stored review. */
  private refreshFromEvent(review: PrReview, event: ReviewEvent): void {
    const text = (key: string) => (typeof event.data[key] === 'string' && event.data[key] ? String(event.data[key]) : undefined)
    review.pr.title = text('title') ?? review.pr.title
    review.pr.author = text('author') ?? review.pr.author
    review.pr.headSha = text('headSha') ?? review.pr.headSha
    review.pr.baseSha = text('baseSha') ?? review.pr.baseSha
  }

  private blank(id: string, event: ReviewEvent, login: string): PrReview {
    const now = this.iso()
    return {
      id,
      prRef: event.prRef,
      reviewer: { login, mode: this.deps.identityMode ?? this.deps.policy.identity },
      status: 'idle',
      pr: {
        title: String(event.data['title'] ?? ''),
        author: String(event.data['author'] ?? ''),
        baseSha: String(event.data['baseSha'] ?? ''),
        headSha: String(event.data['headSha'] ?? ''),
        state: 'open',
        draft: event.data['draft'] === true,
        url: event.prRef.url ?? String(event.data['url'] ?? ''),
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
  if (events.length > 0 && events.every(event => event.kind === 'manual' || event.kind === 'command')) return 0
  if (events.some(event => event.kind === 'commits-pushed' || event.kind === 'review-requested')) {
    return debounceSec * 1000
  }
  return 30_000
}

function eventToKind(event: ReviewEvent, review: PrReview): RoundKind {
  const reviewed = review.totals.rounds > 0
  if (event.kind === 'review-requested' || event.kind === 'manual') return reviewed ? 'rerequest' : 'initial'
  if (event.kind === 'commits-pushed' || event.kind === 'ready-for-review') return 'incremental'
  if (event.kind === 'merged' || event.kind === 'closed') return 'closing'
  if (event.kind === 'command') {
    return event.data['command'] === 'review' ? (reviewed ? 'rerequest' : 'initial') : 'command'
  }
  if (event.kind === 'comment') {
    const body = typeof event.data['body'] === 'string' ? event.data['body'] : undefined
    if (parseReviewCommand(body)?.name === 'review'
      && commandIsAuthorised(event.actor, review.pr.author, review.reviewer.login)) {
      return reviewed ? 'rerequest' : 'initial'
    }
  }
  return 'conversation'
}

function applyDeterministicClose(review: PrReview): void {
  for (const finding of review.ledger.findings) {
    if (finding.status !== 'open') continue
    const status: FindingStatus = finding.threadId || finding.commentId ? 'addressed' : 'outdated'
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
    if (threadId && review.ledger.findings.some(f => f.threadId === threadId || f.commentId === threadId)) return false
    return true
  })
}
