// ── SQLite State Backend ──────────────────────────────────────────────────────
//
// Implements StateBackend using better-sqlite3 for fully local mode (Phase 5).
// All state is persisted in a single SQLite file (default: ~/.coro/state.db).
// Zero external dependencies — no Redis, no Postgres, no cloud.
//
// Used when:  `coro init --local` → runner starts without cloud config
// Upgradable: `coro login` adds cloud config → next restart uses CloudStateBackend

import Database from 'better-sqlite3'
import {
  Job,
  JobInput,
  JobType,
  PrMapping,
  Proposal,
  ProposalStatus,
} from '@coro-ai/cloud-protocol'
import { defaultWorkflowPath } from '../jobs/helpers'
import { buildJobRecord, resolveWorkflowPath } from '../jobs/creation'
import type { StateBackend } from './backend'
import type { ExternalRef } from '@coro-ai/cloud-protocol'
import { repoKeyForStorage } from '../plugins/refs'

// ── Schema ────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    data         TEXT NOT NULL,
    type         TEXT NOT NULL,
    status       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

  CREATE TABLE IF NOT EXISTS job_logs (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id   TEXT NOT NULL,
    content  TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(job_id);

  CREATE TABLE IF NOT EXISTS pr_mappings (
    pr_id   INTEGER PRIMARY KEY,
    job_id  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jira_mappings (
    ticket_id  TEXT PRIMARY KEY,
    job_id     TEXT NOT NULL
  );

  -- External reference mappings (P5+).
  -- Single home for every plugin-rooted lookup: PR ids, ticket keys,
  -- and any future kind. repo_key is required for kind=pull_request
  -- (enforced at the runtime layer via repoKeyForStorage) so PR id 42
  -- in two different repos cannot alias each other; for kinds where
  -- repo is not meaningful the column stores the empty string.
  CREATE TABLE IF NOT EXISTS external_ref_mappings (
    plugin_id    TEXT NOT NULL,
    kind         TEXT NOT NULL,
    repo_key     TEXT NOT NULL DEFAULT '',
    external_id  TEXT NOT NULL,
    job_id       TEXT NOT NULL,
    PRIMARY KEY (plugin_id, kind, repo_key, external_id),
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_external_ref_job ON external_ref_mappings(job_id);

  CREATE TABLE IF NOT EXISTS repo_mappings (
    repo_slug  TEXT NOT NULL,
    job_id     TEXT NOT NULL,
    PRIMARY KEY (repo_slug, job_id)
  );

  CREATE TABLE IF NOT EXISTS proposals (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    data        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_proposals_tenant ON proposals(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
`;

// ── Implementation ────────────────────────────────────────────────────────────

export class SqliteStateBackend implements StateBackend {
  private db: Database.Database

  constructor(
    dbPath: string,
    private readonly coroIntelligenceDir: string = '',
    private readonly logger?: { warn: (obj: object, msg: string) => void; debug?: (obj: object, msg: string) => void },
    /**
     * Optional base layer fallback. When omitted, `buildJobRecord`
     * defaults to `getBaseLayerRoot()` from `@coro-ai/intelligence-base`,
     * so production callers can leave it undefined and tests can pin
     * a specific fixture root.
     */
    private readonly baseLayerDir?: string,
  ) {
    this.db = new Database(dbPath)
    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL')
    // Enable foreign keys
    this.db.pragma('foreign_keys = ON')
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    this.db.exec(SCHEMA_SQL)
  }

  /** Close the database connection. Call on shutdown. */
  close(): void {
    this.db.close()
  }

  // ── Job CRUD ──────────────────────────────────────────────────────────────

  async createJob(input: JobInput): Promise<Job> {
    const jobType = inputToJobType(input)
    const workflowPath = resolveWorkflowPath(input, defaultWorkflowPath(jobType))
    const job = await buildJobRecord(input, jobType, workflowPath, {
      coroIntelligenceDir: this.coroIntelligenceDir,
      baseLayerDir: this.baseLayerDir,
      logger: this.logger,
    })
    const now = job.createdAt
    const prMappings = job.prMappings

    this.db.prepare(`
      INSERT INTO jobs (id, data, type, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(job.id, JSON.stringify(job), job.type, job.status, now, now)

    // Persist PR mapping if present
    for (const pm of prMappings) {
      this.db.prepare(`INSERT OR REPLACE INTO pr_mappings (pr_id, job_id) VALUES (?, ?)`)
        .run(pm.prId, job.id)
    }

    // Persist repo mapping
    const repoSlug = input.params['repoSlug'] as string | undefined
    if (repoSlug) {
      this.db.prepare(`INSERT OR REPLACE INTO repo_mappings (repo_slug, job_id) VALUES (?, ?)`)
        .run(repoSlug, job.id)
    }

    // Persist Jira mapping
    const jiraTicketId = input.params['jiraTicketId'] as string | undefined
    if (jiraTicketId) {
      this.db.prepare(`INSERT OR REPLACE INTO jira_mappings (ticket_id, job_id) VALUES (?, ?)`)
        .run(jiraTicketId, job.id)
    }

    return job
  }

  async getJob(jobId: string): Promise<Job | null> {
    const row = this.db.prepare('SELECT data FROM jobs WHERE id = ?').get(jobId) as { data: string } | undefined
    if (!row) return null
    return JSON.parse(row.data) as Job
  }

  async listJobs(): Promise<Job[]> {
    const rows = this.db.prepare('SELECT data FROM jobs ORDER BY created_at DESC').all() as Array<{ data: string }>
    return rows.map(r => JSON.parse(r.data) as Job)
  }

  async listJobsByType(type: JobType): Promise<Job[]> {
    const rows = this.db.prepare('SELECT data FROM jobs WHERE type = ? ORDER BY created_at DESC')
      .all(type) as Array<{ data: string }>
    return rows.map(r => JSON.parse(r.data) as Job)
  }

  async listChildJobs(parentJobId: string): Promise<Job[]> {
    // SQLite has no dedicated index on campaignParentId; the field lives in
    // the JSON blob. For tree sizes we expect (≤ a few dozen children)
    // a scan + filter is fast enough. We can switch to a generated column
    // + index later if profiles say otherwise.
    const rows = this.db.prepare('SELECT data FROM jobs ORDER BY created_at DESC')
      .all() as Array<{ data: string }>
    const out: Job[] = []
    for (const r of rows) {
      const job = JSON.parse(r.data) as Job
      if (job.campaignParentId === parentJobId) out.push(job)
    }
    return out
  }

  async updateJob(jobId: string, patch: Partial<Job>): Promise<Job> {
    const existing = await this.getJob(jobId)
    if (!existing) throw new Error(`Job not found: ${jobId}`)

    // `id`, `type`, and `createdAt` are part of a job's identity and must not
    // be rewritten by a patch. `workflowPath` is intentionally NOT pinned —
    // `convert_to_campaign` flips it from the regular job workflow to the
    // campaign workflow as part of an atomic phase/status transition. Pinning
    // it here in the past silently dropped that change and produced jobs whose
    // persisted `phase` (e.g. `campaign-planning`) no longer matched their
    // persisted `workflowPath`.
    const updated: Job = {
      ...existing,
      ...patch,
      id: existing.id,
      type: existing.type,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }

    this.db.prepare(`
      UPDATE jobs SET data = ?, status = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(updated), updated.status, updated.updatedAt, jobId)

    return updated
  }

  async deleteJob(jobId: string): Promise<void> {
    // Foreign key cascade handles job_logs
    this.db.prepare('DELETE FROM pr_mappings WHERE job_id = ?').run(jobId)
    this.db.prepare('DELETE FROM jira_mappings WHERE job_id = ?').run(jobId)
    this.db.prepare('DELETE FROM repo_mappings WHERE job_id = ?').run(jobId)
    this.db.prepare('DELETE FROM job_logs WHERE job_id = ?').run(jobId)
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId)
  }

  // ── Log streaming ─────────────────────────────────────────────────────────

  async appendLog(jobId: string, line: string): Promise<void> {
    const entry = `${new Date().toISOString()} ${line}`
    this.db.prepare('INSERT INTO job_logs (job_id, content) VALUES (?, ?)').run(jobId, entry)
  }

  async getLog(jobId: string, start = 0, end = -1): Promise<string[]> {
    if (end === -1) {
      // All from start
      const rows = this.db.prepare(
        'SELECT content FROM job_logs WHERE job_id = ? ORDER BY id LIMIT -1 OFFSET ?'
      ).all(jobId, start) as Array<{ content: string }>
      return rows.map(r => r.content)
    }

    const limit = end - start + 1
    const rows = this.db.prepare(
      'SELECT content FROM job_logs WHERE job_id = ? ORDER BY id LIMIT ? OFFSET ?'
    ).all(jobId, limit, start) as Array<{ content: string }>
    return rows.map(r => r.content)
  }

  async logLength(jobId: string): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM job_logs WHERE job_id = ?')
      .get(jobId) as { cnt: number }
    return row.cnt
  }

  // ── External-ref mappings (P5+) ────────────────────────────────────────────

  async mapExternalRef(ref: ExternalRef, jobId: string): Promise<void> {
    const repoKey = repoKeyForStorage(ref)
    this.db.prepare(`
      INSERT OR REPLACE INTO external_ref_mappings
        (plugin_id, kind, repo_key, external_id, job_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(ref.pluginId, ref.kind, repoKey, ref.externalId, jobId)
  }

  async getJobByExternalRef(ref: ExternalRef): Promise<Job | null> {
    const repoKey = ref.repoKey ?? ''
    const row = this.db.prepare(`
      SELECT job_id FROM external_ref_mappings
       WHERE plugin_id = ? AND kind = ? AND repo_key = ? AND external_id = ?
    `).get(ref.pluginId, ref.kind, repoKey, ref.externalId) as { job_id: string } | undefined
    if (!row) return null
    return this.getJob(row.job_id)
  }

  // ── PR mappings (legacy adapter — writes to BOTH tables) ──────────────────
  //
  // Until P9 we keep dual-writing to the legacy `pr_mappings` table
  // so a downgrade is still possible while the new
  // `external_ref_mappings` table is on the hot path. Reads prefer
  // the new table and fall back to the legacy one for rows that
  // pre-date the migration.

  async mapPrToJob(prId: number, jobId: string): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO pr_mappings (pr_id, job_id) VALUES (?, ?)')
      .run(prId, jobId)
    // The legacy method does not carry a pluginId or repoKey; we
    // intentionally do NOT mirror into `external_ref_mappings` here
    // because the row would violate the `repo_key NOT NULL`
    // requirement for `pull_request`. Callers that have a real
    // {@link ExternalRef} (the dispatcher, the SCM plugin) should
    // prefer {@link mapExternalRef} directly.
  }

  async getJobByPr(prId: number): Promise<Job | null> {
    // Prefer the new table — query for any pull_request mapping
    // whose externalId matches across plugins. PR ids are namespaced
    // by `(plugin_id, repo_key)` so two repos with the same PR id
    // don't collide here, but a single numeric `prId` arriving via
    // the legacy path may match more than one row; the dispatcher's
    // legacy callers don't carry that disambiguation, so we resolve
    // to the most-recently-mapped job (highest rowid).
    const newRow = this.db.prepare(`
      SELECT job_id FROM external_ref_mappings
       WHERE kind = 'pull_request' AND external_id = ?
       ORDER BY rowid DESC
       LIMIT 1
    `).get(String(prId)) as { job_id: string } | undefined
    if (newRow) return this.getJob(newRow.job_id)

    const row = this.db.prepare('SELECT job_id FROM pr_mappings WHERE pr_id = ?')
      .get(prId) as { job_id: string } | undefined
    if (!row) return null
    return this.getJob(row.job_id)
  }

  async addPrMapping(jobId: string, mapping: PrMapping): Promise<Job> {
    const job = await this.getJob(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)

    job.prMappings.push(mapping)
    await this.mapPrToJob(mapping.prId, jobId)
    // We have a repo for this mapping, so we can also write it into
    // the new table under the registry's default SCM plugin id is
    // unknown here — the dispatcher's `scm_create_pr` writes via
    // {@link mapExternalRef} directly when it has a plugin context.
    // The legacy fallback above keeps reads working either way.
    return this.updateJob(jobId, { prMappings: job.prMappings })
  }

  async markPrMerged(jobId: string, prId: number, mergedAt: string): Promise<Job> {
    const job = await this.getJob(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)

    const updated = job.prMappings.map(m =>
      m.prId === prId ? { ...m, mergedAt } : m
    )
    return this.updateJob(jobId, { prMappings: updated })
  }

  // ── Jira mappings (legacy adapter) ─────────────────────────────────────────

  async mapJiraTicketToJob(ticketId: string, jobId: string): Promise<void> {
    // Dual-write: legacy table + plugin-aware table. Tickets carry no
    // repo so `repo_key` stays the empty string. The plugin id
    // defaults to `'jira'` — the only tracker plugin the legacy
    // method has ever been used by; new code should call
    // {@link mapExternalRef} with an explicit plugin.
    this.db.prepare('INSERT OR REPLACE INTO jira_mappings (ticket_id, job_id) VALUES (?, ?)')
      .run(ticketId, jobId)
    this.db.prepare(`
      INSERT OR REPLACE INTO external_ref_mappings
        (plugin_id, kind, repo_key, external_id, job_id)
      VALUES ('jira', 'ticket', '', ?, ?)
    `).run(ticketId, jobId)
  }

  async getJobByJiraTicket(ticketId: string): Promise<Job | null> {
    const newRow = this.db.prepare(`
      SELECT job_id FROM external_ref_mappings
       WHERE plugin_id = 'jira' AND kind = 'ticket' AND repo_key = '' AND external_id = ?
    `).get(ticketId) as { job_id: string } | undefined
    if (newRow) return this.getJob(newRow.job_id)

    const row = this.db.prepare('SELECT job_id FROM jira_mappings WHERE ticket_id = ?')
      .get(ticketId) as { job_id: string } | undefined
    if (!row) return null
    return this.getJob(row.job_id)
  }

  // ── Repo mappings ──────────────────────────────────────────────────────────

  async mapRepoToJob(repoSlug: string, jobId: string): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO repo_mappings (repo_slug, job_id) VALUES (?, ?)')
      .run(repoSlug, jobId)
  }

  // ── Proposals ──────────────────────────────────────────────────────────────

  async createProposal(proposal: Omit<Proposal, 'id'>): Promise<Proposal> {
    const id = `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    const full: Proposal = { ...proposal, id }

    this.db.prepare(`
      INSERT INTO proposals (id, tenant_id, data, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, proposal.tenantId, JSON.stringify(full), proposal.status ?? 'pending', now, now)

    return full
  }

  async listProposals(tenantId: string, status?: ProposalStatus): Promise<Proposal[]> {
    if (status) {
      const rows = this.db.prepare(
        'SELECT data FROM proposals WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC'
      ).all(tenantId, status) as Array<{ data: string }>
      return rows.map(r => JSON.parse(r.data) as Proposal)
    }

    const rows = this.db.prepare(
      'SELECT data FROM proposals WHERE tenant_id = ? ORDER BY created_at DESC'
    ).all(tenantId) as Array<{ data: string }>
    return rows.map(r => JSON.parse(r.data) as Proposal)
  }

  async getProposal(tenantId: string, id: string): Promise<Proposal | null> {
    const row = this.db.prepare(
      'SELECT data FROM proposals WHERE id = ? AND tenant_id = ?'
    ).get(id, tenantId) as { data: string } | undefined
    if (!row) return null
    return JSON.parse(row.data) as Proposal
  }

  async updateProposal(tenantId: string, id: string, updates: Partial<Proposal>): Promise<Proposal> {
    const existing = await this.getProposal(tenantId, id)
    if (!existing) throw new Error(`Proposal not found: ${id}`)

    const now = new Date().toISOString()
    const updated = { ...existing, ...updates, id: existing.id, tenantId: existing.tenantId, updatedAt: now }

    this.db.prepare(`
      UPDATE proposals SET data = ?, status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?
    `).run(JSON.stringify(updated), updated.status, now, id, tenantId)

    return updated
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function inputToJobType(input: JobInput): JobType {
  switch (input.type) {
    case 'job':         return JobType.Job
    case 'self-update': return JobType.SelfUpdate
    default:
      throw new Error(`Unknown job type: ${String((input as unknown as Record<string, unknown>).type)}`)
  }
}
