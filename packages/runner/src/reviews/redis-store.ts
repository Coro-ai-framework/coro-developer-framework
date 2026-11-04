import type Redis from 'ioredis'
import type { PrReview } from '@coro-ai/cloud-protocol'
import { type ReviewListFilter, type ReviewStore, reviewMatchesStatus } from './store'

const INDEX = 'reviews:index'

export class RedisReviewStore implements ReviewStore {
  constructor(private readonly redis: Redis) {}

  async get(id: string): Promise<PrReview | null> {
    const raw = await this.redis.get(`review:${id}`)
    return raw ? JSON.parse(raw) as PrReview : null
  }

  async save(review: PrReview): Promise<void> {
    await this.redis.set(`review:${review.id}`, JSON.stringify(review))
    await this.redis.sadd(INDEX, review.id)
  }

  async list(filter?: ReviewListFilter): Promise<PrReview[]> {
    const ids = await this.redis.smembers(INDEX)
    if (ids.length === 0) return []
    const raws = await this.redis.mget(...ids.map(id => `review:${id}`))
    return raws
      .filter((raw): raw is string => typeof raw === 'string')
      .map(raw => JSON.parse(raw) as PrReview)
      .filter(review => reviewMatchesStatus(review, filter))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
}
