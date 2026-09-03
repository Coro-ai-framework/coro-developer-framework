import {
  Job,
  JobInput,
  JobType,
  PrMapping,
  Proposal,
  ProposalStatus,
  type Investigation,
  type InvestigationListQuery,
  type InvestigationListResult,
  type InvestigationPatch,
} from '@coro-ai/cloud-protocol'
import type { ExternalRef } from '@coro-ai/cloud-protocol'

// ── State backend interface ───────────────────────────────────────────────────
//
// All job state persistence goes through this interface. The runner, MCP
// handlers, dispatcher, and server never touch a concrete store
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
  /**
   * List all jobs whose `campaignParentId` matches the given parent. Used
   * by the dispatcher's coordinator hook to enrich the parent's
   * `campaignChildren[]` view, by webhook resolvers, and by the dashboard's
   * campaign view.
   */
  listChildJobs(parentJobId: string): Promise<Job[]>
  deleteJob(jobId: string): Promise<void>

  // ── Log streaming ──────────────────────────────────────────────────────────

  appendLog(jobId: string, line: string): Promise<void>
  getLog(jobId: string, start?: number, end?: number): Promise<string[]>
  logLength(jobId: string): Promise<number>

  // ── External-ref mapping (provider-neutral, P5+) ──────────────────────────
  //
  // Plugin-aware mappings are the canonical lookup primitive after
  // P5. Every PR/ticket the runner cares about is recorded as an
  // {@link ExternalRef} so the dispatcher and webhook router don't
  // need to know which provider they're talking to.
  //
  // The legacy `mapPrToJob` / `getJobByPr` / `mapJiraTicketToJob` /
  // `getJobByJiraTicket` methods below now delegate to these, but
  // remain on the interface for one release while old callers
  // migrate.

  /**
   * Persist a mapping from `ref` to `jobId`. Replaces any prior
   * mapping for the same ref (insert-or-replace semantics).
   */
  mapExternalRef(ref: ExternalRef, jobId: string): Promise<void>

  /**
   * Look up the job that owns the given external reference. Returns
   * `null` when no mapping exists.
   */
  getJobByExternalRef(ref: ExternalRef): Promise<Job | null>

  // ── PR mappings (legacy, delegates to mapExternalRef) ─────────────────────

  mapPrToJob(prId: number, jobId: string): Promise<void>
  getJobByPr(prId: number): Promise<Job | null>
  addPrMapping(jobId: string, mapping: PrMapping): Promise<Job>
  markPrMerged(jobId: string, prId: number, mergedAt: string): Promise<Job>

  // ── Jira mappings (legacy, delegates to mapExternalRef) ───────────────────

  mapJiraTicketToJob(ticketId: string, jobId: string): Promise<void>
  getJobByJiraTicket(ticketId: string): Promise<Job | null>

  // ── Repo mappings ──────────────────────────────────────────────────────────

  mapRepoToJob(repoSlug: string, jobId: string): Promise<void>

  // ── Proposals ──────────────────────────────────────────────────────────────

  createProposal(proposal: Omit<Proposal, 'id'>): Promise<Proposal>
  listProposals(tenantId: string, status?: ProposalStatus): Promise<Proposal[]>
  getProposal(tenantId: string, id: string): Promise<Proposal | null>
  updateProposal(tenantId: string, id: string, updates: Partial<Proposal>): Promise<Proposal>

  // ── Plan-mode investigations (New Run chat) ────────────────────────────────
  //
  // Durable record of a dashboard plan-mode conversation. The in-memory
  // intake session is the hot LLM cache; this is what survives restart
  // and powers the New Run history rail. Implementations merge patches
  // so a stream turn cannot wipe `items` and a UI PUT cannot wipe `turns`.

  upsertInvestigation(record: InvestigationPatch): Promise<Investigation>
  getInvestigation(id: string): Promise<Investigation | null>
  listInvestigations(query: InvestigationListQuery): Promise<InvestigationListResult>
  deleteInvestigation(id: string): Promise<void>
}
