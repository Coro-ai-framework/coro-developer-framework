// ── ReviewStore ──────────────────────────────────────────────────────────────
//
// Durable home for one Review per pull request. Rounds are ordinary jobs;
// this store is the only place their continuity lives. Implementations:
// SQLite (local + hybrid runner), Redis, Postgres (cloud), an on-PR
// marker comment (headless CI), and an in-memory store for tests.

import type { PrReview, ReviewStatus } from '@coro-ai/cloud-protocol'

export interface ReviewListFilter {
  status?: ReviewStatus | readonly ReviewStatus[]
}

export interface ReviewStore {
  initialize?(): Promise<void>
  get(id: string): Promise<PrReview | null>
  save(review: PrReview): Promise<void>
  list(filter?: ReviewListFilter): Promise<PrReview[]>
}

export class MemoryReviewStore implements ReviewStore {
  private readonly rows = new Map<string, PrReview>()

  async get(id: string): Promise<PrReview | null> {
    const row = this.rows.get(id)
    return row ? structuredClone(row) : null
  }

  async save(review: PrReview): Promise<void> {
    this.rows.set(review.id, structuredClone(review))
  }

  async list(filter?: ReviewListFilter): Promise<PrReview[]> {
    const wanted = filter?.status
      ? new Set(Array.isArray(filter.status) ? filter.status : [filter.status])
      : null
    return [...this.rows.values()]
      .filter(row => !wanted || wanted.has(row.status))
      .map(row => structuredClone(row))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
}

export function reviewMatchesStatus(review: PrReview, filter?: ReviewListFilter): boolean {
  if (!filter?.status) return true
  const wanted = Array.isArray(filter.status) ? filter.status : [filter.status]
  return wanted.includes(review.status)
}
