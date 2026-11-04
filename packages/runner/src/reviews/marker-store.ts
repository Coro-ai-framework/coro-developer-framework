import type { PrReview } from '@coro-ai/cloud-protocol'
import { decodeReviewState, renderSummaryComment } from './marker'
import { MemoryReviewStore, type ReviewStore } from './store'

/**
 * Headless store. The sticky summary comment on the pull request is the
 * Review. `load` reads that comment; `flush` writes the trimmed marker back.
 */
export class PrMarkerReviewStore implements ReviewStore {
  private readonly memory = new MemoryReviewStore()

  constructor(
    private readonly readBodies: () => Promise<string[]>,
    private readonly writeBody: (body: string) => Promise<void>,
  ) {}

  async hydrate(): Promise<void> {
    const bodies = await this.readBodies()
    for (const body of bodies) {
      const review = decodeReviewState(body)
      if (review) await this.memory.save(review)
    }
  }

  async get(id: string): Promise<PrReview | null> {
    return this.memory.get(id)
  }

  async save(review: PrReview): Promise<void> {
    await this.memory.save(review)
    await this.writeBody(renderSummaryComment(review))
  }

  async list(filter?: Parameters<ReviewStore['list']>[0]): Promise<PrReview[]> {
    return this.memory.list(filter)
  }
}
