import type Database from 'better-sqlite3'
import type { PrReview } from '@coro-ai/cloud-protocol'
import { type ReviewListFilter, type ReviewStore, reviewMatchesStatus } from './store'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pr_reviews (
    id          TEXT PRIMARY KEY,
    plugin_id   TEXT NOT NULL,
    repo_key    TEXT NOT NULL,
    external_id TEXT NOT NULL,
    status      TEXT NOT NULL,
    data        TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pr_reviews_status ON pr_reviews(status);
  CREATE INDEX IF NOT EXISTS idx_pr_reviews_ref ON pr_reviews(plugin_id, repo_key, external_id);
`

export class SqliteReviewStore implements ReviewStore {
  constructor(private readonly db: Database.Database) {}

  async initialize(): Promise<void> {
    this.db.exec(SCHEMA)
  }

  async get(id: string): Promise<PrReview | null> {
    const row = this.db.prepare('SELECT data FROM pr_reviews WHERE id = ?').get(id) as { data: string } | undefined
    return row ? JSON.parse(row.data) as PrReview : null
  }

  async save(review: PrReview): Promise<void> {
    this.db.prepare(`
      INSERT INTO pr_reviews (id, plugin_id, repo_key, external_id, status, data, updated_at)
      VALUES (@id, @pluginId, @repoKey, @externalId, @status, @data, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        data = excluded.data,
        updated_at = excluded.updated_at
    `).run({
      id: review.id,
      pluginId: review.prRef.pluginId,
      repoKey: review.prRef.repoKey ?? '',
      externalId: review.prRef.externalId,
      status: review.status,
      data: JSON.stringify(review),
      updatedAt: review.updatedAt,
    })
  }

  async list(filter?: ReviewListFilter): Promise<PrReview[]> {
    const rows = this.db.prepare(
      'SELECT data FROM pr_reviews ORDER BY updated_at DESC',
    ).all() as { data: string }[]
    return rows
      .map(row => JSON.parse(row.data) as PrReview)
      .filter(review => reviewMatchesStatus(review, filter))
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM pr_reviews WHERE id = ?').run(id)
  }
}
