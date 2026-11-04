import type { PrReview } from '@coro-ai/cloud-protocol'
import { decodeReviewState, renderSummaryComment } from './marker'
import type { ReviewStore } from './store'

export interface MarkerComment {
  id: string
  body: string
}

/**
 * Headless store. The sticky summary comment on the pull request carries
 * the Review between CI runs. Within a run, state lives in `inner` — the
 * same store the round's tools read and write — so the agent and the
 * coordinator see one record. `flush` writes it back to that one comment,
 * editing it in place when the SCM allows.
 */
export class PrMarkerReviewStore implements ReviewStore {
  private commentId: string | undefined

  constructor(
    private readonly inner: ReviewStore,
    private readonly readComments: () => Promise<MarkerComment[]>,
    private readonly writeComment: (body: string, existingId: string | undefined) => Promise<{ id: string } | void>,
  ) {}

  async hydrate(): Promise<void> {
    await this.inner.initialize?.()
    const comments = await this.readComments()
    for (const comment of comments) {
      const review = decodeReviewState(comment.body)
      if (!review) continue
      this.commentId = comment.id
      await this.inner.save(review)
    }
  }

  async flush(id: string): Promise<void> {
    const review = await this.inner.get(id)
    if (!review) return
    const written = await this.writeComment(renderSummaryComment(review), this.commentId)
    if (written?.id) this.commentId = written.id
  }

  get(id: string): Promise<PrReview | null> {
    return this.inner.get(id)
  }

  save(review: PrReview): Promise<void> {
    return this.inner.save(review)
  }

  list(filter?: Parameters<ReviewStore['list']>[0]): Promise<PrReview[]> {
    return this.inner.list(filter)
  }

  delete(id: string): Promise<void> {
    return this.inner.delete(id)
  }
}
