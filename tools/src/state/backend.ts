import { Job, JobInput, JobType, PrMapping, Proposal, ProposalStatus } from '../jobs/types'

// ── State backend interface ───────────────────────────────────────────────────
//
// All job state persistence goes through this interface. The runner, MCP
// handlers, dispatcher, server, and watcher never touch a concrete store
// directly — they always call through StateBackend.
//
// Implementations:
//   RedisStateBackend    — current Redis-backed storage (Phase 1)
//   PostgresStateBackend — cloud control plane (Phase 2)
//   SqliteStateBackend   — fully local mode (Phase 5)
//   CloudStateBackend    — WebSocket RPC to cloud (Phase 3)

export interface StateBackend {

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Backend-specific initialization run once at startup.
   * Redis: rebuilds PR reverse-lookup keys.
   * Postgres/SQLite: runs migrations.
   */
  initialize?(): Promise<void>

  // ── Job CRUD ────────────────────────────────────────────────────────────────

  createJob(input: JobInput): Promise<Job>
  getJob(jobId: string): Promise<Job | null>
  updateJob(jobId: string, patch: Partial<Job>): Promise<Job>
  listJobs(): Promise<Job[]>
  listJobsByType(type: JobType): Promise<Job[]>
  deleteJob(jobId: string): Promise<void>

  // ── Log streaming ──────────────────────────────────────────────────────────

  appendLog(jobId: string, line: string): Promise<void>
  getLog(jobId: string, start?: number, end?: number): Promise<string[]>
  logLength(jobId: string): Promise<number>

  // ── PR mappings ────────────────────────────────────────────────────────────

  mapPrToJob(prId: number, jobId: string): Promise<void>
  getJobByPr(prId: number): Promise<Job | null>
  addPrMapping(jobId: string, mapping: PrMapping): Promise<Job>
  markPrMerged(jobId: string, prId: number, mergedAt: string): Promise<Job>

  // ── Jira mappings ──────────────────────────────────────────────────────────

  mapJiraTicketToJob(ticketId: string, jobId: string): Promise<void>
  getJobByJiraTicket(ticketId: string): Promise<Job | null>

  // ── Repo mappings ──────────────────────────────────────────────────────────

  mapRepoToJob(repoSlug: string, jobId: string): Promise<void>

  // ── Proposals ──────────────────────────────────────────────────────────────

  createProposal(proposal: Omit<Proposal, 'id'>): Promise<Proposal>
  listProposals(tenantId: string, status?: ProposalStatus): Promise<Proposal[]>
  getProposal(tenantId: string, id: string): Promise<Proposal | null>
  updateProposal(tenantId: string, id: string, updates: Partial<Proposal>): Promise<Proposal>
}
