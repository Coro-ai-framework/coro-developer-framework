import Redis from 'ioredis'
import {
  Job,
  JobInput,
  JobType,
  STATUS_QUEUED,
  PrMapping,
  defaultWorkflowPath,
} from './types'
import { loadWorkflowConfig, resolveInitialPhase, getPhaseConfig } from '../workflow-parser'

// ── Redis key schema ──────────────────────────────────────────────────────────
//
//  job:{jobId}              String (JSON)  Full Job object
//  job:{jobId}:log          List           Log lines (RPUSH / LRANGE)
//  pr:{prId}:job            String         jobId that owns this PR
//  jira:{ticketId}:job      String         jobId for this Jira ticket
//  repo:{repoSlug}:jobs     Set            All job IDs that touched this repo
//  jobs:all                 Set            All job IDs (for listJobs)
//  jobs:type:{type}         Set            Job IDs by JobType

function keyJob(jobId: string): string          { return `job:${jobId}` }
function keyLog(jobId: string): string          { return `job:${jobId}:log` }
function keyPr(prId: number): string            { return `pr:${prId}:job` }
function keyJira(ticketId: string): string      { return `jira:${ticketId}:job` }
function keyRepo(repoSlug: string): string      { return `repo:${repoSlug}:jobs` }
function keyAllJobs(): string                   { return 'jobs:all' }
function keyJobsByType(type: JobType): string   { return `jobs:type:${type}` }

// ── Serialization ─────────────────────────────────────────────────────────────

/**
 * Strip the transient `_signals` field before writing to Redis.
 * It is in-process only and must never be persisted.
 */
function serialize(job: Job): string {
  const { _signals, ...persistable } = job
  void _signals  // intentionally discarded
  return JSON.stringify(persistable)
}

function deserialize(raw: string): Job {
  const job = JSON.parse(raw) as Job
  // Ensure _signals starts clean on every load
  job._signals = {}
  return job
}

// ── Registry class ────────────────────────────────────────────────────────────

export class JobRegistry {
  constructor(
    private readonly redis: Redis,
    private readonly a5aiDir: string = '',
    private readonly logger?: { warn: (obj: object, msg: string) => void; debug?: (obj: object, msg: string) => void },
  ) {}

  // ── Create ────────────────────────────────────────────────────────────────

  async createJob(input: JobInput): Promise<Job> {
    const now = new Date().toISOString()

    const jobType = inputToJobType(input)
    const workflowPath = defaultWorkflowPath(jobType)
    const triggerSource = input.triggerSource ?? 'cli'

    // Load the workflow config to determine the initial phase.
    const config = workflowPath && this.a5aiDir
      ? await loadWorkflowConfig(workflowPath, this.a5aiDir, this.logger as Parameters<typeof loadWorkflowConfig>[2])
      : null

    const initialPhase = config
      ? resolveInitialPhase(config, triggerSource)
      : 'init'
    const phaseConfig = config ? getPhaseConfig(config, initialPhase) : null
    const initialStatus = phaseConfig?.status ?? config?.initialStatus ?? STATUS_QUEUED

    // Generate a human-readable ID from the params
    const label = (input.params['serviceName'] as string)
      ?? (input.params['jiraTicketId'] as string)
      ?? input.type
    const id = `${label}-${input.type}-${Date.now()}`

    // Build initial PR mappings from params if present (e.g. self-update jobs)
    const prMappings: PrMapping[] = []
    if (input.params['prId'] && input.params['branchName']) {
      prMappings.push({
        prId: input.params['prId'] as number,
        feature: input.params['branchName'] as string,
        repoSlug: (input.params['repoSlug'] as string) ?? '',
        openedAt: now,
      })
    }

    const job: Job = {
      id,
      type: jobType,
      workflowPath,
      params: input.params,
      triggerSource,
      status: initialStatus,
      phase: initialPhase,
      currentFeature: null,
      prMappings,
      conversationHistory: [],
      createdAt: now,
      updatedAt: now,
      _signals: {},
    }

    await this.persist(job)
    return job
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  async getJob(jobId: string): Promise<Job | null> {
    const raw = await this.redis.get(keyJob(jobId))
    if (!raw) return null
    return deserialize(raw)
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

  /**
   * Shallow-merge `patch` into the existing job and persist.
   * Always updates `updatedAt`.
   * `_signals` in the patch is silently dropped — use the in-memory job object
   * to communicate signals between tools and the runner within a single turn.
   */
  async updateJob(jobId: string, patch: Partial<Job>): Promise<Job> {
    const existing = await this.getJob(jobId)
    if (!existing) throw new Error(`Job not found: ${jobId}`)

    const { _signals, ...safePatch } = patch
    void _signals

    const updated: Job = {
      ...existing,
      ...safePatch,
      id: existing.id,           // immutable
      type: existing.type,       // immutable
      workflowPath: existing.workflowPath,  // immutable
      createdAt: existing.createdAt,        // immutable
      updatedAt: new Date().toISOString(),
      _signals: existing._signals ?? {},
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

  /** Append a log line to the job's log stream. */
  async appendLog(jobId: string, line: string): Promise<void> {
    const entry = `${new Date().toISOString()} ${line}`
    await this.redis.rpush(keyLog(jobId), entry)
  }

  /**
   * Read log lines.
   * @param start 0-based start index (default 0)
   * @param end   0-based end index inclusive, -1 for all (default -1)
   */
  async getLog(jobId: string, start = 0, end = -1): Promise<string[]> {
    return this.redis.lrange(keyLog(jobId), start, end)
  }

  /** Returns the total number of log lines for a job. */
  async logLength(jobId: string): Promise<number> {
    return this.redis.llen(keyLog(jobId))
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async persist(job: Job): Promise<void> {
    const pipeline = this.redis.pipeline()
    pipeline.set(keyJob(job.id), serialize(job))
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
        jobs.push(deserialize(raw))
      }
    }

    // Sort newest first
    return jobs.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function inputToJobType(input: JobInput): JobType {
  switch (input.type) {
    case 'migration':   return JobType.Migration
    case 'feature':     return JobType.Feature
    case 'self-update': return JobType.SelfUpdate
  }
}
