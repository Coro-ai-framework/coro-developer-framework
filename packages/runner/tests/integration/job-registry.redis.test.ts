import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Redis from 'ioredis'
import { RedisStateBackend } from '../../src/state/redis-backend'
import { JobType, STATUS_QUEUED } from '../../src/jobs/types'
import { createTestRedis, flushTestRedis } from './redis-client'
import { resolveIntelligenceRoot } from './repo-root'

const skipRedis =
  process.env.SKIP_REDIS_INTEGRATION === '1' || process.env.SKIP_REDIS_INTEGRATION === 'true'

const noopLogger = {
  warn: (): void => {},
  debug: (): void => {},
}

describe.skipIf(skipRedis)('RedisStateBackend (Redis integration)', () => {
  let redis: Redis
  let backend: RedisStateBackend
  let intelligenceRoot: string

  beforeAll(async () => {
    redis = createTestRedis()
    try {
      await redis.connect()
      await redis.ping()
    } catch (e) {
      await redis.disconnect()
      throw new Error(
        'Redis is not reachable on the configured host/port. ' +
          'Start Redis (for example: docker run -d -p 6379:6379 redis:7-alpine). ' +
          'Tests use logical DB 15 only. ' +
          'To skip these tests, set SKIP_REDIS_INTEGRATION=1. ' +
          `Underlying error: ${(e as Error).message}`,
      )
    }
    intelligenceRoot = resolveIntelligenceRoot()
  })

  beforeEach(async () => {
    await flushTestRedis(redis)
    backend = new RedisStateBackend(redis, intelligenceRoot, noopLogger)
  })

  afterAll(async () => {
    await flushTestRedis(redis)
    await redis.quit()
  })

  describe('createJob + getJob', () => {
    it('persists a generic job and loads workflow-driven phase/status from disk', async () => {
      const job = await backend.createJob({
        type: 'job',
        triggerSource: 'cli',
        params: { serviceName: 'svc-a', repoSlug: 'svc-a' },
      })

      expect(job.type).toBe(JobType.Job)
      expect(job.workflowPath).toBe('workflows/job/workflow.md')
      expect(job.phase).toBe('init')
      expect(job.status).toBe('initializing')
      expect(job.params['serviceName']).toBe('svc-a')

      const loaded = await backend.getJob(job.id)
      expect(loaded).not.toBeNull()
      expect(loaded!.id).toBe(job.id)
      expect(loaded!.createdAt).toBe(job.createdAt)
    })

    it('uses Jira override initial phase for generic jobs', async () => {
      const job = await backend.createJob({
        type: 'job',
        triggerSource: 'jira',
        params: { serviceName: 'feat-x', repoSlug: 'feat-x', jiraTicketId: 'PROJ-99' },
      })

      expect(job.phase).toBe('spec-writing')
      expect(job.status).toBe('spec-writing')
    })

    it('uses default initial phase for generic jobs from CLI', async () => {
      const job = await backend.createJob({
        type: 'job',
        triggerSource: 'cli',
        params: { serviceName: 'feat-y', repoSlug: 'feat-y' },
      })

      expect(job.phase).toBe('planning')
    })

    it('creates self-update jobs without a workflow file', async () => {
      const job = await backend.createJob({
        type: 'self-update',
        triggerSource: 'internal',
        params: { changedFiles: ['agents/coder.md'] },
      })

      expect(job.type).toBe(JobType.SelfUpdate)
      expect(job.workflowPath).toBe('')
      expect(job.phase).toBe('init')
      expect(job.status).toBe(STATUS_QUEUED)
    })

    it('seeds prMappings when prId and branchName are present in params', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: {
          serviceName: 'svc-pr',
          repoSlug: 'svc-pr',
          prId: 555,
          branchName: 'job/foo',
        },
      })

      expect(job.prMappings).toHaveLength(1)
      expect(job.prMappings[0]).toMatchObject({
        prId: 555,
        workItem: 'job/foo',
        repoSlug: 'svc-pr',
      })
    })

    it('returns null for unknown job id', async () => {
      expect(await backend.getJob('no-such-job')).toBeNull()
    })
  })

  describe('indexes and listings', () => {
    it('adds job id to global and type sets', async () => {
      const j1 = await backend.createJob({
        type: 'job',
        params: { serviceName: 'm1', repoSlug: 'r1' },
      })
      const j2 = await backend.createJob({
        type: 'job',
        params: { serviceName: 'f1', repoSlug: 'r2' },
      })

      const all = await backend.listJobs()
      const ids = all.map(j => j.id).sort()
      expect(ids).toContain(j1.id)
      expect(ids).toContain(j2.id)

      const jobsByType = await backend.listJobsByType(JobType.Job)
      expect(jobsByType.some(j => j.id === j1.id)).toBe(true)
      expect(jobsByType.some(j => j.id === j2.id)).toBe(true)

      expect(jobsByType.some(j => j.id === j2.id)).toBe(true)
    })

    it('sorts listJobs by createdAt descending (newest first)', async () => {
      const a = await backend.createJob({
        type: 'job',
        params: { serviceName: 'older', repoSlug: 'x1' },
      })
      await new Promise(r => setTimeout(r, 5))
      const b = await backend.createJob({
        type: 'job',
        params: { serviceName: 'newer', repoSlug: 'x2' },
      })

      const list = await backend.listJobs()
      const idxA = list.findIndex(j => j.id === a.id)
      const idxB = list.findIndex(j => j.id === b.id)
      expect(idxB).toBeLessThan(idxA)
    })

    it('indexes repo slug when present', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'svc', repoSlug: 'my-repo' },
      })

      const members = await redis.smembers('repo:my-repo:jobs')
      expect(members).toContain(job.id)
    })

    it('indexes Jira ticket id when present', async () => {
      const job = await backend.createJob({
        type: 'job',
        triggerSource: 'jira',
        params: { serviceName: 'j', repoSlug: 'r', jiraTicketId: 'ABC-42' },
      })

      const mapped = await redis.get('jira:ABC-42:job')
      expect(mapped).toBe(job.id)
    })
  })

  describe('updateJob', () => {
    it('merges partial updates and refreshes updatedAt', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'u1', repoSlug: 'u1' },
      })
      const before = job.updatedAt

      await new Promise(r => setTimeout(r, 5))

      const updated = await backend.updateJob(job.id, {
        status: 'coding',
        phase: 'coding',
        sessionId: 'sess-123',
      })

      expect(updated.status).toBe('coding')
      expect(updated.phase).toBe('coding')
      expect(updated.sessionId).toBe('sess-123')
      expect(updated.id).toBe(job.id)
      expect(updated.type).toBe(job.type)
      expect(updated.workflowPath).toBe(job.workflowPath)
      expect(updated.createdAt).toBe(job.createdAt)
      expect(updated.updatedAt > before).toBe(true)

      const loaded = await backend.getJob(job.id)
      expect(loaded!.sessionId).toBe('sess-123')
    })

    it('throws when job does not exist', async () => {
      await expect(backend.updateJob('missing-id', { status: 'complete' })).rejects.toThrow(
        'Job not found',
      )
    })
  })

  describe('deleteJob', () => {
    it('removes job document, log, and set memberships', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'd1', repoSlug: 'repo-del' },
      })
      await backend.appendLog(job.id, 'line1')

      await backend.deleteJob(job.id)

      expect(await backend.getJob(job.id)).toBeNull()
      expect(await redis.get(`job:${job.id}`)).toBeNull()
      expect(await redis.llen(`job:${job.id}:log`)).toBe(0)
      expect(await redis.sismember('jobs:all', job.id)).toBe(0)
      expect(await redis.sismember(`jobs:type:${JobType.Job}`, job.id)).toBe(0)
      expect(await redis.sismember('repo:repo-del:jobs', job.id)).toBe(0)
    })

    it('is idempotent when job is already gone', async () => {
      await expect(backend.deleteJob('never-created')).resolves.toBeUndefined()
    })
  })

  describe('PR and Jira mappings', () => {
    it('mapPrToJob and getJobByPr roundtrip', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'p1', repoSlug: 'p1' },
      })
      await backend.mapPrToJob(777, job.id)

      const found = await backend.getJobByPr(777)
      expect(found!.id).toBe(job.id)
    })

    it('mapJiraTicketToJob and getJobByJiraTicket roundtrip', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'j1', repoSlug: 'j1' },
      })
      await backend.mapJiraTicketToJob('XYZ-1', job.id)

      const found = await backend.getJobByJiraTicket('XYZ-1')
      expect(found!.id).toBe(job.id)
    })

    it('mapRepoToJob adds job id to repo set', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'mr', repoSlug: 'extra-repo' },
      })
      await backend.mapRepoToJob('another-repo', job.id)

      const members = await redis.smembers('repo:another-repo:jobs')
      expect(members).toContain(job.id)
    })
  })

  describe('PR mappings on Job', () => {
    it('addPrMapping appends and registers pr key', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'apm', repoSlug: 'apm' },
      })

      const updated = await backend.addPrMapping(job.id, {
        prId: 1001,
        workItem: 'feat-a',
        repoSlug: 'apm',
        openedAt: '2026-04-04T12:00:00Z',
      })

      expect(updated.prMappings).toHaveLength(1)
      const byPr = await backend.getJobByPr(1001)
      expect(byPr!.id).toBe(job.id)
    })

    it('throws addPrMapping when job is missing', async () => {
      await expect(
        backend.addPrMapping('nope', {
          prId: 1,
          workItem: 'f',
          repoSlug: 'r',
          openedAt: '2026-01-01T00:00:00Z',
        }),
      ).rejects.toThrow('Job not found')
    })

    it('markPrMerged sets mergedAt on the matching PR', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'mrg', repoSlug: 'mrg' },
      })
      await backend.addPrMapping(job.id, {
        prId: 2002,
        workItem: 'b',
        repoSlug: 'mrg',
        openedAt: '2026-04-04T12:00:00Z',
      })

      const merged = await backend.markPrMerged(job.id, 2002, '2026-04-05T00:00:00Z')
      const m = merged.prMappings.find(x => x.prId === 2002)
      expect(m!.mergedAt).toBe('2026-04-05T00:00:00Z')
    })

    it('throws markPrMerged when job is missing', async () => {
      await expect(backend.markPrMerged('missing', 1, '2026-01-01')).rejects.toThrow('Job not found')
    })
  })

  describe('appendLog / getLog / logLength', () => {
    it('stores chronological log lines', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'log', repoSlug: 'log' },
      })

      await backend.appendLog(job.id, 'first')
      await backend.appendLog(job.id, 'second')

      expect(await backend.logLength(job.id)).toBe(2)
      const lines = await backend.getLog(job.id)
      expect(lines.some(l => l.endsWith(' first'))).toBe(true)
      expect(lines.some(l => l.endsWith(' second'))).toBe(true)
    })

    it('getLog supports range slicing', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'lr', repoSlug: 'lr' },
      })
      await backend.appendLog(job.id, 'a')
      await backend.appendLog(job.id, 'b')
      await backend.appendLog(job.id, 'c')

      const slice = await backend.getLog(job.id, 0, 1)
      expect(slice).toHaveLength(2)
    })
  })
})
