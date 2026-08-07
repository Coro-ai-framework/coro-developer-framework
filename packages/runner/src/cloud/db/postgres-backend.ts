// SPDX-License-Identifier: LicenseRef-Coro-Commercial-1.0

import crypto from 'crypto'
import { eq, and, sql, asc, desc } from 'drizzle-orm'
import type { CloudDb } from '../db/connection'
import * as schema from '../db/schema'
import type { StateBackend } from '../../state/backend'
import {
  Job,
  JobInput,
  JobType,
  PrMapping,
  Proposal,
  ProposalStatus,
  WorkItem,
  Insight,
  PhaseUsage,
  Artifact,
  CampaignChild,
} from '@coro-ai/cloud-protocol'
import { defaultWorkflowPath } from '../../jobs/helpers'
import { buildJobRecord, resolveWorkflowPath } from '../../jobs/creation'
import type { ExternalRef } from '@coro-ai/cloud-protocol'
import { repoKeyForStorage } from '../../plugins/refs'

// ── Row ↔ Job mapping ─────────────────────────────────────────────────────────

type JobRow = typeof schema.jobs.$inferSelect

function rowToJob(row: JobRow): Job {
  const job: Job = {
    id: row.id,
    type: row.type as JobType,
    workflowPath: row.workflowPath,
    params: row.params,
    triggerSource: row.triggerSource as Job['triggerSource'],
    status: row.status,
    phase: row.phase,
    currentWorkItem: row.currentWorkItem,
    workItems: (row.workItems ?? []) as WorkItem[],
    workItemLoopCount: row.workItemLoopCount,
    prMappings: (row.prMappings ?? []) as PrMapping[],
    interactive: ((row.params as Record<string, unknown>)?.['interactive'] === true),
    artifacts: (row.artifacts ?? []) as Artifact[],
    insights: (row.insights ?? []) as Insight[],
    tokenUsage: {
      inputTokens: row.tokenUsageInput,
      outputTokens: row.tokenUsageOutput,
      cacheReadInputTokens: row.tokenUsageCacheRead,
      cacheCreationInputTokens: row.tokenUsageCacheCreation,
      totalCostUsd: row.tokenUsageCostUsd,
    },
    phaseUsage: (row.phaseUsage ?? []) as PhaseUsage[],
    sessionId: row.sessionId ?? undefined,
    // `conversationHistory` is opaque JSON written by stateless executors.
    // We cast through unknown — only the executor that wrote it interprets it.
    conversationHistory: row.conversationHistory == null
      ? undefined
      : (row.conversationHistory as Job['conversationHistory']),
    awaitingEvent: row.awaitingEvent ?? undefined,
    awaitingPrId: row.awaitingPrId ?? undefined,
    escalationMessage: row.escalationMessage ?? undefined,
    pendingPrompt: row.pendingPrompt ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }

  // Optional fields are only set when present so `isCampaignJob` and the
  // checkpoint-state machinery keep their "undefined means absent" contract.
  if (row.awaitingNextPhase) job.awaitingNextPhase = row.awaitingNextPhase
  if (row.approvedAdvanceFromPhase) job.approvedAdvanceFromPhase = row.approvedAdvanceFromPhase
  if (row.campaignParentId) job.campaignParentId = row.campaignParentId
  if (row.campaignChildren !== null && row.campaignChildren !== undefined) {
    job.campaignChildren = (row.campaignChildren ?? []) as CampaignChild[]
  }

  return job
}

function jobToInsert(job: Job, teamId: string): typeof schema.jobs.$inferInsert {
  return {
    id: job.id,
    teamId,
    type: job.type as typeof schema.jobs.$inferInsert['type'],
    workflowPath: job.workflowPath,
    params: job.params,
    triggerSource: job.triggerSource as typeof schema.jobs.$inferInsert['triggerSource'],
    status: job.status,
    phase: job.phase,
    currentWorkItem: job.currentWorkItem,
    workItems: job.workItems as unknown[],
    workItemLoopCount: job.workItemLoopCount,
    prMappings: job.prMappings as unknown[],
    insights: job.insights as unknown[],
    tokenUsageInput: job.tokenUsage.inputTokens,
    tokenUsageOutput: job.tokenUsage.outputTokens,
    tokenUsageCacheRead: job.tokenUsage.cacheReadInputTokens,
    tokenUsageCacheCreation: job.tokenUsage.cacheCreationInputTokens,
    tokenUsageCostUsd: job.tokenUsage.totalCostUsd,
    phaseUsage: job.phaseUsage as unknown[],
    sessionId: job.sessionId ?? null,
    conversationHistory: job.conversationHistory == null
      ? null
      : (job.conversationHistory as unknown[]),
    awaitingEvent: job.awaitingEvent ?? null,
    awaitingPrId: job.awaitingPrId ?? null,
    escalationMessage: job.escalationMessage ?? null,
    pendingPrompt: job.pendingPrompt ?? null,
    artifacts: (job.artifacts ?? []) as unknown[],
    awaitingNextPhase: job.awaitingNextPhase ?? null,
    approvedAdvanceFromPhase: job.approvedAdvanceFromPhase ?? null,
    // `null` (not undefined) when absent, so the column stays distinguishable
    // from an empty children array on a campaign with zero registrations.
    campaignChildren: job.campaignChildren === undefined
      ? null
      : (job.campaignChildren as unknown[]),
    campaignParentId: job.campaignParentId ?? null,
  }
}

// ── PostgresStateBackend ──────────────────────────────────────────────────────

export class PostgresStateBackend implements StateBackend {
  constructor(
    private readonly db: CloudDb,
    private readonly teamId: string,
    /**
     * Optional tenant overlay root. The cloud worker doesn't typically
     * materialise a tenant overlay on disk before job creation (the
     * runner-side resolver does), so this is left empty in production.
     * Tests may pin it to override base for fixture purposes.
     */
    private readonly coroIntelligenceDir: string = '',
    /**
     * Optional base layer fallback. When omitted, `buildJobRecord`
     * defaults to `getBaseLayerRoot()` from `@coro-ai/intelligence-base`.
     */
    private readonly baseLayerDir?: string,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    // Drizzle migrations are handled externally (drizzle-kit push/migrate).
    // Nothing to do here at runtime.
  }

  // ── Job CRUD ──────────────────────────────────────────────────────────────

  async createJob(input: JobInput): Promise<Job> {
    const jobType = input.type as JobType
    const workflowPath = resolveWorkflowPath(input, defaultWorkflowPath(jobType))
    const job = await buildJobRecord(input, jobType, workflowPath, {
      coroIntelligenceDir: this.coroIntelligenceDir,
      baseLayerDir: this.baseLayerDir,
    })

    await this.db.insert(schema.jobs).values(jobToInsert(job, this.teamId))

    // Seed PR mapping index
    for (const pr of job.prMappings) {
      await this.mapPrToJob(pr.prId, job.id)
    }

    return job
  }

  async getJob(jobId: string): Promise<Job | null> {
    const rows = await this.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId))
      .limit(1)

    return rows[0] ? rowToJob(rows[0]) : null
  }

  async updateJob(jobId: string, patch: Partial<Job>): Promise<Job> {
    const existing = await this.getJob(jobId)
    if (!existing) throw new Error(`Job not found: ${jobId}`)

    const merged: Job = {
      ...existing,
      ...patch,
      id: existing.id,
      type: existing.type,
      workflowPath: existing.workflowPath,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }

    // Build the Drizzle SET clause from the merged job
    const row = jobToInsert(merged, this.teamId)
    await this.db
      .update(schema.jobs)
      .set({
        ...row,
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, jobId))

    return merged
  }

  async listJobs(): Promise<Job[]> {
    const rows = await this.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.teamId, this.teamId))

    return rows.map(rowToJob).sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
  }

  async listJobsByType(type: JobType): Promise<Job[]> {
    const rows = await this.db
      .select()
      .from(schema.jobs)
      .where(and(
        eq(schema.jobs.teamId, this.teamId),
        eq(schema.jobs.type, type as typeof schema.jobs.$inferInsert['type']),
      ))

    return rows.map(rowToJob)
  }

  async listChildJobs(parentJobId: string): Promise<Job[]> {
    const rows = await this.db
      .select()
      .from(schema.jobs)
      .where(and(
        eq(schema.jobs.teamId, this.teamId),
        eq(schema.jobs.campaignParentId, parentJobId),
      ))

    return rows.map(rowToJob).sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )
  }

  async deleteJob(jobId: string): Promise<void> {
    await this.db.delete(schema.jobs).where(eq(schema.jobs.id, jobId))
  }

  // ── Log streaming ─────────────────────────────────────────────────────────

  async appendLog(jobId: string, line: string): Promise<void> {
    const entry = `${new Date().toISOString()} ${line}`

    // Get current max line number
    const result = await this.db
      .select({ maxLine: sql<number>`coalesce(max(${schema.jobLogs.lineNumber}), -1)` })
      .from(schema.jobLogs)
      .where(eq(schema.jobLogs.jobId, jobId))

    const nextLine = (result[0]?.maxLine ?? -1) + 1

    await this.db.insert(schema.jobLogs).values({
      id: crypto.randomUUID(),
      jobId,
      lineNumber: nextLine,
      content: entry,
    })
  }

  async getLog(jobId: string, start = 0, end = -1): Promise<string[]> {
    const conditions = [
      eq(schema.jobLogs.jobId, jobId),
      sql`${schema.jobLogs.lineNumber} >= ${start}`,
    ]

    if (end >= 0) {
      conditions.push(sql`${schema.jobLogs.lineNumber} <= ${end}`)
    }

    const rows = await this.db
      .select({ content: schema.jobLogs.content })
      .from(schema.jobLogs)
      .where(and(...conditions))
      .orderBy(asc(schema.jobLogs.lineNumber))

    return rows.map(r => r.content)
  }

  async logLength(jobId: string): Promise<number> {
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(schema.jobLogs)
      .where(eq(schema.jobLogs.jobId, jobId))

    return result[0]?.count ?? 0
  }

  // ── PR mappings ───────────────────────────────────────────────────────────
  //
  // All PR-mapping operations are scoped to `this.teamId` so two teams
  // sharing the cloud DB never alias PR ids across repos. The composite
  // PK `(teamId, prId)` enforces this at the storage level — see the
  // schema for the rationale.

  // ── External-ref mappings (P5+) ───────────────────────────────────────────

  async mapExternalRef(ref: ExternalRef, jobId: string): Promise<void> {
    const repoKey = repoKeyForStorage(ref)
    await this.db
      .insert(schema.externalRefMappings)
      .values({
        teamId: this.teamId,
        pluginId: ref.pluginId,
        kind: ref.kind,
        repoKey,
        externalId: ref.externalId,
        jobId,
      })
      .onConflictDoUpdate({
        target: [
          schema.externalRefMappings.teamId,
          schema.externalRefMappings.pluginId,
          schema.externalRefMappings.kind,
          schema.externalRefMappings.repoKey,
          schema.externalRefMappings.externalId,
        ],
        set: { jobId },
      })
  }

  async getJobByExternalRef(ref: ExternalRef): Promise<Job | null> {
    const repoKey = ref.repoKey ?? ''
    const rows = await this.db
      .select({ jobId: schema.externalRefMappings.jobId })
      .from(schema.externalRefMappings)
      .where(and(
        eq(schema.externalRefMappings.teamId, this.teamId),
        eq(schema.externalRefMappings.pluginId, ref.pluginId),
        eq(schema.externalRefMappings.kind, ref.kind),
        eq(schema.externalRefMappings.repoKey, repoKey),
        eq(schema.externalRefMappings.externalId, ref.externalId),
      ))
      .limit(1)
    if (!rows[0]) return null
    return this.getJob(rows[0].jobId)
  }

  // ── PR mappings (legacy adapter) ──────────────────────────────────────────
  //
  // Reads prefer `external_ref_mappings` and fall back to the legacy
  // `pr_mappings` table for rows written before the P5 migration.
  // Writes still hit the legacy table so a downgrade window is
  // possible — callers with a real {@link ExternalRef} should use
  // {@link mapExternalRef} directly.

  async mapPrToJob(prId: number, jobId: string): Promise<void> {
    await this.db
      .insert(schema.prMappings)
      .values({ prId, jobId, teamId: this.teamId })
      .onConflictDoUpdate({
        target: [schema.prMappings.teamId, schema.prMappings.prId],
        set: { jobId },
      })
  }

  async getJobByPr(prId: number): Promise<Job | null> {
    // Legacy table first. It is keyed by `prId` alone, so it answers a
    // numeric-only question exactly — whereas the plugin-aware table can
    // only be searched here by `externalId`, ignoring the plugin and
    // `repoKey` that give a PR id its meaning. Querying that table first
    // let another repo's PR #5 shadow the correct legacy row, delivering
    // the event to an unrelated job.
    //
    // Callers holding a full `ExternalRef` never reach this method: they
    // go through `resolveJobByExternalRef`, whose exact lookup runs first
    // and which discards a by-number answer that names the wrong repo.
    const rows = await this.db
      .select({ jobId: schema.prMappings.jobId })
      .from(schema.prMappings)
      .where(and(
        eq(schema.prMappings.teamId, this.teamId),
        eq(schema.prMappings.prId, prId),
      ))
      .limit(1)
    if (rows[0]) return this.getJob(rows[0].jobId)

    // Last resort, for PRs registered only through `mapExternalRef`.
    // Still ambiguous across repos; resolve to the most recent row.
    const newRows = await this.db
      .select({ jobId: schema.externalRefMappings.jobId })
      .from(schema.externalRefMappings)
      .where(and(
        eq(schema.externalRefMappings.teamId, this.teamId),
        eq(schema.externalRefMappings.kind, 'pull_request'),
        eq(schema.externalRefMappings.externalId, String(prId)),
      ))
      .orderBy(desc(schema.externalRefMappings.externalId))
      .limit(1)

    if (!newRows[0]) return null
    return this.getJob(newRows[0].jobId)
  }

  async addPrMapping(jobId: string, mapping: PrMapping): Promise<Job> {
    const job = await this.getJob(jobId)
    if (!job) throw new Error(`Job not found: ${jobId}`)

    job.prMappings.push(mapping)
    await this.mapPrToJob(mapping.prId, jobId)
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

  // ── Jira mappings ─────────────────────────────────────────────────────────
  //
  // Team-scoped via composite PK `(teamId, ticketId)` for the same reason
  // as `prMappings` — keep multi-tenant data isolation at the storage layer.

  async mapJiraTicketToJob(ticketId: string, jobId: string): Promise<void> {
    // Dual-write: legacy table + new plugin-aware table. Tickets
    // carry no repo so `repo_key` stays empty.
    await this.db
      .insert(schema.jiraMappings)
      .values({ ticketId, jobId, teamId: this.teamId })
      .onConflictDoUpdate({
        target: [schema.jiraMappings.teamId, schema.jiraMappings.ticketId],
        set: { jobId },
      })
    await this.db
      .insert(schema.externalRefMappings)
      .values({
        teamId: this.teamId,
        pluginId: 'jira',
        kind: 'ticket',
        repoKey: '',
        externalId: ticketId,
        jobId,
      })
      .onConflictDoUpdate({
        target: [
          schema.externalRefMappings.teamId,
          schema.externalRefMappings.pluginId,
          schema.externalRefMappings.kind,
          schema.externalRefMappings.repoKey,
          schema.externalRefMappings.externalId,
        ],
        set: { jobId },
      })
  }

  async getJobByJiraTicket(ticketId: string): Promise<Job | null> {
    const newRows = await this.db
      .select({ jobId: schema.externalRefMappings.jobId })
      .from(schema.externalRefMappings)
      .where(and(
        eq(schema.externalRefMappings.teamId, this.teamId),
        eq(schema.externalRefMappings.pluginId, 'jira'),
        eq(schema.externalRefMappings.kind, 'ticket'),
        eq(schema.externalRefMappings.repoKey, ''),
        eq(schema.externalRefMappings.externalId, ticketId),
      ))
      .limit(1)
    if (newRows[0]) return this.getJob(newRows[0].jobId)

    const rows = await this.db
      .select({ jobId: schema.jiraMappings.jobId })
      .from(schema.jiraMappings)
      .where(and(
        eq(schema.jiraMappings.teamId, this.teamId),
        eq(schema.jiraMappings.ticketId, ticketId),
      ))
      .limit(1)

    if (!rows[0]) return null
    return this.getJob(rows[0].jobId)
  }

  // ── Repo mappings ─────────────────────────────────────────────────────────

  async mapRepoToJob(_repoSlug: string, _jobId: string): Promise<void> {
    // Repo → job is 1:N. In Postgres we rely on querying the jobs table
    // by params->>'repoSlug'. No separate mapping table needed.
  }

  // ── Proposals ─────────────────────────────────────────────────────────────

  async createProposal(proposal: Omit<Proposal, 'id'>): Promise<Proposal> {
    const id = crypto.randomUUID()
    const now = new Date()

    await this.db.insert(schema.proposals).values({
      id,
      tenantId: proposal.tenantId,
      jobId: proposal.jobId,
      type: proposal.type,
      title: proposal.title,
      rationale: proposal.rationale,
      description: proposal.description,
      status: proposal.status as typeof schema.proposals.$inferInsert['status'],
      files: proposal.files as unknown[],
      createdAt: now,
      updatedAt: now,
    })

    return { ...proposal, id }
  }

  async listProposals(tenantId: string, status?: ProposalStatus): Promise<Proposal[]> {
    const conditions = [eq(schema.proposals.tenantId, tenantId)]
    if (status) {
      conditions.push(eq(schema.proposals.status, status))
    }

    const rows = await this.db
      .select()
      .from(schema.proposals)
      .where(and(...conditions))

    return rows.map(r => ({
      id: r.id,
      tenantId: r.tenantId,
      jobId: r.jobId,
      type: r.type as Proposal['type'],
      title: r.title,
      rationale: r.rationale,
      description: r.description,
      status: r.status as ProposalStatus,
      files: (r.files ?? []) as Proposal['files'],
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      reviewedBy: r.reviewedBy ?? undefined,
      reviewNote: r.reviewNote ?? undefined,
    }))
  }

  async getProposal(tenantId: string, id: string): Promise<Proposal | null> {
    const rows = await this.db
      .select()
      .from(schema.proposals)
      .where(and(
        eq(schema.proposals.id, id),
        eq(schema.proposals.tenantId, tenantId),
      ))
      .limit(1)

    const r = rows[0]
    if (!r) return null

    return {
      id: r.id,
      tenantId: r.tenantId,
      jobId: r.jobId,
      type: r.type as Proposal['type'],
      title: r.title,
      rationale: r.rationale,
      description: r.description,
      status: r.status as ProposalStatus,
      files: (r.files ?? []) as Proposal['files'],
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      reviewedBy: r.reviewedBy ?? undefined,
      reviewNote: r.reviewNote ?? undefined,
    }
  }

  async updateProposal(tenantId: string, id: string, updates: Partial<Proposal>): Promise<Proposal> {
    const existing = await this.getProposal(tenantId, id)
    if (!existing) throw new Error(`Proposal not found: ${id}`)

    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (updates.status) set.status = updates.status
    if (updates.reviewedBy !== undefined) set.reviewedBy = updates.reviewedBy
    if (updates.reviewNote !== undefined) set.reviewNote = updates.reviewNote
    if (updates.files) set.files = updates.files

    await this.db
      .update(schema.proposals)
      .set(set)
      .where(and(
        eq(schema.proposals.id, id),
        eq(schema.proposals.tenantId, tenantId),
      ))

    return { ...existing, ...updates, updatedAt: new Date().toISOString() }
  }
}
