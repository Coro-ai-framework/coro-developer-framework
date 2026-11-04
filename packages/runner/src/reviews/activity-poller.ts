import type { Logger } from 'pino'
import type { PrReview, ReviewEventKind } from '@coro-ai/cloud-protocol'
import type { PluginRegistry } from '../plugins/registry'
import type { ScmPluginRuntime, ScmPollSnapshot } from '../plugins/types'
import { deltaToReviewKind, diffPrSnapshot, type DetectorSnapshot } from './pr-change-detector'
import type { ReviewPolicy } from './policy'
import type { ReviewStore } from './store'
import type { ReviewEventSink, ReviewEventSource } from './sources'

const WATCHED = new Set(['idle', 'awaiting-verdict', 'paused', 'failed'])

export class ActivityPoller implements ReviewEventSource {
  private timer: ReturnType<typeof setInterval> | null = null
  private sink: ReviewEventSink | null = null
  private readonly previous = new Map<string, DetectorSnapshot>()

  constructor(
    private readonly store: ReviewStore,
    private readonly plugins: PluginRegistry,
    private readonly policy: ReviewPolicy,
    private readonly logger: Logger,
  ) {}

  start(sink: ReviewEventSink): void {
    this.sink = sink
    const tick = () => { void this.poll().catch(err => this.logger.warn({ err }, 'review activity poll failed')) }
    this.timer = setInterval(tick, this.policy.activityIntervalSec * 1000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async poll(): Promise<void> {
    if (!this.sink) return
    const reviews = await this.store.list()
    for (const review of reviews) {
      if (!WATCHED.has(review.status)) continue
      if (review.pauseReason && review.pauseReason !== 'review-request-removed' && review.status === 'paused') continue
      const runtime = this.plugins.byId(review.prRef.pluginId) as ScmPluginRuntime | undefined
      if (!runtime?.pollPr) continue
      let snap: ScmPollSnapshot
      try {
        snap = await runtime.pollPr(review.prRef)
      } catch (err) {
        this.logger.debug({ err, reviewId: review.id }, 'activity poll skipped a review')
        continue
      }
      const current = toDetector(snap, review)
      const prev = this.previous.get(review.id)
      this.previous.set(review.id, current)
      if (!prev) continue
      const deltas = diffPrSnapshot(prev, current, snap.comments.map(comment => ({
        id: String(comment.id),
        body: comment.body,
        createdAt: comment.createdAt,
        ...(comment.author ? { author: comment.author } : {}),
      })))
      for (const delta of deltas) {
        const kind = deltaToReviewKind(delta)
        if (!kind) continue
        // The baseline can predate the last round; a head that round already reviewed is not news.
        if (kind === 'commits-pushed' && snap.headSha && snap.headSha === review.ledger.lastReviewedSha) continue
        await this.sink({
          kind: kind as ReviewEventKind,
          prRef: review.prRef,
          at: new Date().toISOString(),
          data: { ...delta.payload, headSha: snap.headSha },
          source: 'activity-poll',
        })
      }
    }
  }
}

function toDetector(snap: ScmPollSnapshot, review: PrReview): DetectorSnapshot {
  return {
    state: snap.state,
    approvalCount: snap.approvalCount,
    commentCount: snap.commentCount,
    ...(snap.headSha ? { headSha: snap.headSha } : { headSha: review.pr.headSha }),
    ...(snap.draft !== undefined ? { draft: snap.draft } : {}),
    ...(snap.threadCount !== undefined ? { threadCount: snap.threadCount } : {}),
    ...(snap.resolvedThreadCount !== undefined ? { resolvedThreadCount: snap.resolvedThreadCount } : {}),
  }
}
