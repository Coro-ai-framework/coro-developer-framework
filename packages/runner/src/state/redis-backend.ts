import Redis from 'ioredis'
import {
  Job,
  JobInput,
  JobType,
  PrMapping,
  Proposal,
  ProposalStatus,
  defaultWorkflowPath,
} from '../jobs/types'
import { buildJobRecord, resolveWorkflowPath } from '../jobs/creation'
import type { StateBackend } from './backend'

// ── Redis key schema ──────────────────────────────────────────────────────────

function keyJob(jobId: string): string          { return `job:${jobId}` }
function keyLog(jobId: string): string          { return `job:${jobId}:log` }
function keyPr(prId: number): string            { return `pr:${prId}:job` }
function keyJira(ticketId: string): string      { return `jira:${ticketId}:job` }
function keyRepo(repoSlug: string): string      { return `repo:${repoSlug}:jobs` }
function keyAllJobs(): string                   { return 'jobs:all' }
function keyJobsByType(type: JobType): string   { return `jobs:type:${type}` }

// ── Redis state backend ───────────────────────────────────────────────────────

export class RedisStateBackend implements StateBackend {
  constructor(
    private readonly redis: Redis,
    private readonly coroIntelligenceDir: string = '',
    private readonly logger?: { warn: (obj: object, msg: string) => void; debug?: (obj: object, msg: string) => void },
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    await this.rebuildPrMappings()
  }

  /**
   * Rebuild all pr:{prId}:job reverse-lookup keys from job state in Redis.
   * Called on startup so webhooks can always find parked jobs even after a restart.
   */
  async rebuildPrMappings(): Promise<number> {
    const jobs = await this.listJobs()
    let rebuilt = 0

    for (const job of jobs) {
      // Re-map from prMappings array (the authoritative list)
      for (const mapping of job.prMappings) {
        await this.mapPrToJob(mapping.prId, job.id)
        rebuilt++
      }
      // Also cover jobs parked with awaitingPrId that predate the prMappings approach
      if (job.awaitingPrId) {
        const existing = await this.redis.get(keyPr(job.awaitingPrId))
        if (!existing) {
          await this.mapPrToJob(job.awaitingPrId, job.id)
          rebuilt++
        }
      }
    }

    return rebuilt
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async createJob(input: JobInput): Promise<Job> {
    const jobType = inputToJobType(input)
    const workflowPath = resolveWorkflowPath(input, defaultWorkflowPath(jobType))
    const job = await buildJobRecord(input, jobType, workflowPath, {
      coroIntelligenceDir: this.coroIntelligenceDir,
      logger: this.logger,
    })

    await this.persist(job)
    return job
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async getJob(jobId: string): Promise<Job | null> {
    const raw = await this.redis.get(keyJob(jobId))
    if (!raw) return null
    return normalizeJob(JSON.parse(raw) as Job)
  }

  async listJobs(): Promise<Job[]> {
    const ids = await this.redis.smembers(keyAllJobs())
    return this.loadMany(ids)
  }

  async listJobsByType(type: JobType): Promise<Job[]> {
    const ids = await this.redis.smembers(keyJobsByType(type))
    return this.loadMany(ids)
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async updateJob(jobId: string, patch: Partial<Job>): Promise<Job> {
    const existing = await this.getJob(jobId)
    if (!existing) throw new Error(`Job not found: ${jobId}`)

    const updated: Job = {
      ...existing,
      ...patch,
      id: existing.id,
      type: existing.type,
      workflowPath: existing.workflowPath,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    }

    await this.persist(updated)
    return updated
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async deleteJob(jobId: string): Promise<void> {
    const job = await this.getJob(jobId)
    if (!job) return

    const repoSlug = (job.params['repoSlug'] as string) ?? ''

    const pipeline = this.redis.pipeline()
    pipeline.del(keyJob(jobId))
    pipeline.del(keyLog(jobId))
    pipeline.srem(keyAllJobs(), jobId)
    pipeline.srem(keyJobsByType(job.type), jobId)
    if (repoSlug) pipeline.srem(keyRepo(repoSlug), jobId)
    await pipeline.exec()
  }

  // ── Mappings ──────────────────────────────────────────────────────────────

  async mapPrToJob(prId: number, jobId: string): Promise<void> {
    await this.redis.set(keyPr(prId), jobId)
  }

  async getJobByPr(prId: number): Promise<Job | null> {
    const jobId = await this.redis.get(keyPr(prId))
    if (!jobId) return null
    return this.getJob(jobId)
  }

  async mapJiraTicketToJob(ticketId: string, jobId: string): Promise<void> {
    await this.redis.set(keyJira(ticketId), jobId)
  }

  async getJobByJiraTicket(ticketId: string): Promise<Job | null> {
    const jobId = await this.redis.get(keyJira(ticketId))
    if (!jobId) return null
    return this.getJob(jobId)
  }

  async mapRepoToJob(repoSlug: string, jobId: string): Promise<void> {
    await this.redis.sadd(keyRepo(repoSlug), jobId)
  }

  // ── PR mappings on the Job object ─────────────────────────────────────────

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

  // ── Log streaming ─────────────────────────────────────────────────────────

  async appendLog(jobId: string, line: string): Promise<void> {
    const entry = `${new Date().toISOString()} ${line}`
    await this.redis.rpush(keyLog(jobId), entry)
  }

  async getLog(jobId: string, start = 0, end = -1): Promise<string[]> {
    return this.redis.lrange(keyLog(jobId), start, end)
  }

  async logLength(jobId: string): Promise<number> {
    return this.redis.llen(keyLog(jobId))
  }

  // ── Proposals (Redis stubs — full implementation in PostgresStateBackend) ──

  private readonly proposals = new Map<string, Proposal>()

  async createProposal(proposal: Omit<Proposal, 'id'>): Promise<Proposal> {
    const id = `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const full: Proposal = { ...proposal, id }
    this.proposals.set(id, full)
    return full
  }

  async listProposals(tenantId: string, status?: ProposalStatus): Promise<Proposal[]> {
    const all = Array.from(this.proposals.values())
      .filter(p => p.tenantId === tenantId)
    return status ? all.filter(p => p.status === status) : all
  }

  async getProposal(tenantId: string, id: string): Promise<Proposal | null> {
    const p = this.proposals.get(id)
    if (!p || p.tenantId !== tenantId) return null
    return p
  }

  async updateProposal(tenantId: string, id: string, updates: Partial<Proposal>): Promise<Proposal> {
    const existing = await this.getProposal(tenantId, id)
    if (!existing) throw new Error(`Proposal not found: ${id}`)
    const updated = { ...existing, ...updates, id: existing.id, tenantId: existing.tenantId, updatedAt: new Date().toISOString() }
    this.proposals.set(id, updated)
    return updated
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async persist(job: Job): Promise<void> {
    const pipeline = this.redis.pipeline()
    pipeline.set(keyJob(job.id), JSON.stringify(job))
    pipeline.sadd(keyAllJobs(), job.id)
    pipeline.sadd(keyJobsByType(job.type), job.id)

    const repoSlug = job.params['repoSlug'] as string | undefined
    if (repoSlug) {
      pipeline.sadd(keyRepo(repoSlug), job.id)
    }

    const jiraTicketId = job.params['jiraTicketId'] as string | undefined
    if (jiraTicketId) {
      pipeline.set(keyJira(jiraTicketId), job.id)
    }

    await pipeline.exec()
  }

  private async loadMany(ids: string[]): Promise<Job[]> {
    if (ids.length === 0) return []

    const pipeline = this.redis.pipeline()
    ids.forEach(id => pipeline.get(keyJob(id)))
    const results = await pipeline.exec()

    const jobs: Job[] = []
    for (const result of results ?? []) {
      const [err, raw] = result as [Error | null, string | null]
      if (!err && raw) {
        jobs.push(normalizeJob(JSON.parse(raw) as Job))
      }
    }

    return jobs.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Fill in defaults for fields added after jobs may have been persisted.
 * Keeps reads tolerant of old records that lack the new `interactive` /
 * `artifacts` / `insights` fields.
 */
function normalizeJob(job: Job): Job {
  return {
    ...job,
    interactive: job.interactive ?? false,
    artifacts: Array.isArray(job.artifacts) ? job.artifacts : [],
    insights: Array.isArray(job.insights) ? job.insights : [],
    prMappings: Array.isArray(job.prMappings) ? job.prMappings : [],
    workItems: Array.isArray(job.workItems) ? job.workItems : [],
    phaseUsage: Array.isArray(job.phaseUsage) ? job.phaseUsage : [],
  }
}

function inputToJobType(input: JobInput): JobType {
  switch (input.type) {
    case 'job':         return JobType.Job
    case 'self-update': return JobType.SelfUpdate
    default:
      throw new Error(`Unknown job type: ${String((input as unknown as Record<string, unknown>).type)}`)
  }
}
