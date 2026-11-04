import { sql } from 'drizzle-orm'
import type { PrReview } from '@coro-ai/cloud-protocol'
import type { CloudDb } from '../cloud/db/connection'
import { type ReviewListFilter, type ReviewStore, reviewMatchesStatus } from './store'

/**
 * Additive table for cloud databases created before PR review existed.
 * `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block on
 * some Postgres versions; drizzle's `execute` issues it on its own.
 */
export async function ensureReviewStorage(db: CloudDb): Promise<void> {
  await db.execute(sql`ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'pr-review'`)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS pr_reviews (
      id text PRIMARY KEY,
      team_id text NOT NULL,
      plugin_id text NOT NULL,
      repo_key text NOT NULL DEFAULT '',
      external_id text NOT NULL,
      status text NOT NULL,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS pr_reviews_team_status_idx ON pr_reviews (team_id, status)
  `)
}

export class PostgresReviewStore implements ReviewStore {
  constructor(
    private readonly db: CloudDb,
    private readonly teamId: string,
  ) {}

  async initialize(): Promise<void> {
    await ensureReviewStorage(this.db)
  }

  async get(id: string): Promise<PrReview | null> {
    const rows = await this.db.execute(sql`
      SELECT data FROM pr_reviews WHERE id = ${id} AND team_id = ${this.teamId} LIMIT 1
    `)
    const data = firstData(rows)
    return data ? data as PrReview : null
  }

  async save(review: PrReview): Promise<void> {
    const payload = JSON.stringify(review)
    await this.db.execute(sql`
      INSERT INTO pr_reviews (id, team_id, plugin_id, repo_key, external_id, status, data, updated_at)
      VALUES (
        ${review.id},
        ${this.teamId},
        ${review.prRef.pluginId},
        ${review.prRef.repoKey ?? ''},
        ${review.prRef.externalId},
        ${review.status},
        ${payload}::jsonb,
        ${review.updatedAt}::timestamptz
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        data = EXCLUDED.data,
        updated_at = EXCLUDED.updated_at
    `)
  }

  async list(filter?: ReviewListFilter): Promise<PrReview[]> {
    const rows = await this.db.execute(sql`
      SELECT data FROM pr_reviews WHERE team_id = ${this.teamId} ORDER BY updated_at DESC
    `)
    return rowsOf(rows)
      .map(row => row as PrReview)
      .filter(review => reviewMatchesStatus(review, filter))
  }

  async delete(id: string): Promise<void> {
    await this.db.execute(sql`DELETE FROM pr_reviews WHERE id = ${id} AND team_id = ${this.teamId}`)
  }
}

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: unknown[] }).rows
  }
  return []
}

function firstData(result: unknown): unknown {
  const row = rowsOf(result)[0] as { data?: unknown } | undefined
  return row?.data ?? null
}
