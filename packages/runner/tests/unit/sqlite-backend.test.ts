import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { SqliteStateBackend } from '../../src/state/sqlite-backend'
import { JobType, type Job } from '../../src/jobs/types'
import { resolveIntelligenceRoot } from '../integration/repo-root'

// ── Helpers ────────────────────────────────────────────────────────────────────

const noopLogger = {
  warn: (): void => {},
  debug: (): void => {},
}

let tmpDir: string
let backend: SqliteStateBackend
let intelligenceRoot: string

describe('SqliteStateBackend', () => {
  beforeEach(async () => {
    intelligenceRoot = resolveIntelligenceRoot()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-sqlite-test-'))
    const dbPath = path.join(tmpDir, 'test.db')
    backend = new SqliteStateBackend(dbPath, intelligenceRoot, noopLogger)
    await backend.initialize()
  })

  afterEach(() => {
    backend.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Job CRUD ──────────────────────────────────────────────────────────────

  describe('createJob + getJob', () => {
    it('persists a generic job and loads workflow-driven phase/status', async () => {
      const job = await backend.createJob({
        type: 'job',
        triggerSource: 'cli',
        params: { serviceName: 'svc-a', repoSlug: 'svc-a' },
      })

      expect(job.type).toBe(JobType.Job)
      expect(job.workflowPath).toBe('workflows/job/workflow.md')
      expect(job.phase).toBe('planning')
      expect(job.id).toContain('svc-a-job-')

      const loaded = await backend.getJob(job.id)
      expect(loaded).not.toBeNull()
      expect(loaded!.id).toBe(job.id)
      expect(loaded!.type).toBe(JobType.Job)
      expect(loaded!.params['serviceName']).toBe('svc-a')
    })

    it('creates generic implementation jobs', async () => {
      const job = await backend.createJob({
        type: 'job',
        triggerSource: 'cli',
        params: { serviceName: 'my-svc', description: 'Add rate limiting' },
      })

      expect(job.type).toBe(JobType.Job)
      expect(job.workflowPath).toBe('workflows/job/workflow.md')
    })

    it('creates self-update jobs with the centralized workflow', async () => {
      const job = await backend.createJob({
        type: 'self-update',
        params: { serviceName: 'self' },
      })

      expect(job.type).toBe(JobType.SelfUpdate)
      expect(job.workflowPath).toBe('workflows/self-update/workflow.md')
      expect(job.phase).toBe('tracking')
    })

    it('returns null for unknown job id', async () => {
      const job = await backend.getJob('nonexistent-id')
      expect(job).toBeNull()
    })

    it('seeds prMappings when prId and branchName are present', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: {
          serviceName: 'svc-b',
          prId: 42,
          branchName: 'job/test',
          repoSlug: 'svc-b',
        },
      })

      expect(job.prMappings).toHaveLength(1)
      expect(job.prMappings[0].prId).toBe(42)
      expect(job.prMappings[0].workItem).toBe('job/test')

      // PR mapping should be persisted too
      const found = await backend.getJobByPr(42)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(job.id)
    })
  })

  // ── Listings ──────────────────────────────────────────────────────────────

  describe('listJobs + listJobsByType', () => {
    it('lists all jobs sorted by createdAt descending', async () => {
      const j1 = await backend.createJob({
        type: 'job',
        params: { serviceName: 'a' },
      })
      // Ensure different timestamps
      await new Promise(r => setTimeout(r, 10))
      const j2 = await backend.createJob({
        type: 'job',
        params: { serviceName: 'b' },
      })

      const all = await backend.listJobs()
      expect(all.length).toBe(2)
      expect(all[0].id).toBe(j2.id)  // newest first
      expect(all[1].id).toBe(j1.id)
    })

    it('filters by type', async () => {
      await backend.createJob({ type: 'job', params: { serviceName: 'x' } })
      await backend.createJob({ type: 'job', params: { serviceName: 'y' } })

      const jobs = await backend.listJobsByType(JobType.Job)
      expect(jobs.length).toBe(2)
      expect(jobs.every(job => job.type === JobType.Job)).toBe(true)
    })
  })

  // ── Update ────────────────────────────────────────────────────────────────

  describe('updateJob', () => {
    it('merges partial updates and refreshes updatedAt', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'svc' },
      })

      const updated = await backend.updateJob(job.id, {
        status: 'coding',
        phase: 'planning',
      })

      expect(updated.status).toBe('coding')
      expect(updated.phase).toBe('planning')
      expect(updated.id).toBe(job.id)
      expect(updated.type).toBe(job.type)
      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(job.updatedAt).getTime()
      )
    })

    it('throws when job does not exist', async () => {
      await expect(backend.updateJob('nope', { status: 'coding' }))
        .rejects.toThrow('Job not found')
    })

    it('honours workflowPath in the patch (convert_to_campaign scenario)', async () => {
      // Regression test: previously updateJob pinned `workflowPath` to the
      // existing value, silently dropping it from any patch. That broke
      // `convert_to_campaign`, which atomically flips workflowPath +
      // phase + status — leaving jobs whose persisted phase
      // (`campaign-planning`) didn't match their persisted workflowPath
      // (`workflows/job/workflow.md`), tripping the runner's startup
      // guard on the next resume.
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'svc' },
      })
      expect(job.workflowPath).toBe('workflows/job/workflow.md')

      const updated = await backend.updateJob(job.id, {
        workflowPath: 'workflows/campaign/workflow.md',
        phase: 'campaign-planning',
        status: 'campaign-planning',
      })

      expect(updated.workflowPath).toBe('workflows/campaign/workflow.md')
      expect(updated.phase).toBe('campaign-planning')
      expect(updated.status).toBe('campaign-planning')

      const reloaded = await backend.getJob(job.id)
      expect(reloaded?.workflowPath).toBe('workflows/campaign/workflow.md')
      expect(reloaded?.phase).toBe('campaign-planning')
    })

    it('does not allow id, type, or createdAt to be rewritten', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'svc' },
      })

      const updated = await backend.updateJob(job.id, {
        // The immutability guard is enforced at runtime in updateJob; the
        // patch is typed as Partial<Job> so these fields are accepted by
        // the type system but ignored by the implementation.
        id: 'tampered-id',
        type: 'self-update' as Job['type'],
        createdAt: '1970-01-01T00:00:00.000Z',
        status: 'coding',
      })

      expect(updated.id).toBe(job.id)
      expect(updated.type).toBe(job.type)
      expect(updated.createdAt).toBe(job.createdAt)
      expect(updated.status).toBe('coding')
    })
  })

  // ── Delete ────────────────────────────────────────────────────────────────

  describe('deleteJob', () => {
    it('removes job and associated logs', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'del-me' },
      })
      await backend.appendLog(job.id, 'test log')

      await backend.deleteJob(job.id)

      expect(await backend.getJob(job.id)).toBeNull()
      expect(await backend.logLength(job.id)).toBe(0)
    })

    it('is idempotent when job is already gone', async () => {
      await expect(backend.deleteJob('nonexistent')).resolves.toBeUndefined()
    })
  })

  // ── Log streaming ─────────────────────────────────────────────────────────

  describe('appendLog / getLog / logLength', () => {
    it('stores chronological log lines', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'log-test' },
      })

      await backend.appendLog(job.id, 'line one')
      await backend.appendLog(job.id, 'line two')
      await backend.appendLog(job.id, 'line three')

      const logs = await backend.getLog(job.id)
      expect(logs.length).toBe(3)
      expect(logs[0]).toContain('line one')
      expect(logs[2]).toContain('line three')

      expect(await backend.logLength(job.id)).toBe(3)
    })

    it('getLog supports range slicing', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'slice' },
      })

      for (let i = 0; i < 5; i++) {
        await backend.appendLog(job.id, `line ${i}`)
      }

      const slice = await backend.getLog(job.id, 1, 3)
      expect(slice.length).toBe(3)  // lines at offset 1, 2, 3
      expect(slice[0]).toContain('line 1')
      expect(slice[2]).toContain('line 3')
    })
  })

  // ── PR mappings ────────────────────────────────────────────────────────────

  describe('PR and Jira mappings', () => {
    it('mapPrToJob and getJobByPr roundtrip', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'pr-test' },
      })

      await backend.mapPrToJob(99, job.id)
      const found = await backend.getJobByPr(99)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(job.id)
    })

    it('mapJiraTicketToJob and getJobByJiraTicket roundtrip', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'jira-test' },
      })

      await backend.mapJiraTicketToJob('PROJ-123', job.id)
      const found = await backend.getJobByJiraTicket('PROJ-123')
      expect(found).not.toBeNull()
      expect(found!.id).toBe(job.id)
    })

    it('mapRepoToJob stores the mapping', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'repo-test' },
      })

      await expect(backend.mapRepoToJob('my-repo', job.id)).resolves.toBeUndefined()
    })
  })

  // ── PR mappings on Job object ──────────────────────────────────────────────

  describe('addPrMapping / markPrMerged', () => {
    it('addPrMapping appends and registers pr key', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'pr-add' },
      })

      const updated = await backend.addPrMapping(job.id, {
        prId: 77,
        workItem: 'feat/x',
        repoSlug: 'repo-x',
        openedAt: new Date().toISOString(),
      })

      expect(updated.prMappings).toHaveLength(1)
      expect(updated.prMappings[0].prId).toBe(77)

      const found = await backend.getJobByPr(77)
      expect(found!.id).toBe(job.id)
    })

    it('throws addPrMapping when job is missing', async () => {
      await expect(
        backend.addPrMapping('nope', {
          prId: 1,
          workItem: 'x',
          repoSlug: 'r',
          openedAt: new Date().toISOString(),
        })
      ).rejects.toThrow('Job not found')
    })

    it('markPrMerged sets mergedAt on the matching PR', async () => {
      const job = await backend.createJob({
        type: 'job',
        params: { serviceName: 'merge-test' },
      })

      await backend.addPrMapping(job.id, {
        prId: 88,
        workItem: 'feat/y',
        repoSlug: 'repo-y',
        openedAt: new Date().toISOString(),
      })

      const merged = await backend.markPrMerged(job.id, 88, '2026-04-20T00:00:00Z')
      expect(merged.prMappings[0].mergedAt).toBe('2026-04-20T00:00:00Z')
    })
  })

  // ── Proposals ──────────────────────────────────────────────────────────────

  describe('proposals', () => {
    const baseProposal = {
      tenantId: 'team-1',
      jobId: 'job-1',
      type: 'memory-update' as const,
      title: 'Test proposal',
      rationale: 'Testing',
      description: 'A test',
      status: 'pending' as const,
      files: [{ path: 'memory/test.md', content: '# Test' }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    it('creates and retrieves proposals', async () => {
      const proposal = await backend.createProposal(baseProposal)
      expect(proposal.id).toBeDefined()
      expect(proposal.title).toBe('Test proposal')

      const loaded = await backend.getProposal('team-1', proposal.id)
      expect(loaded).not.toBeNull()
      expect(loaded!.title).toBe('Test proposal')
    })

    it('lists proposals by tenant', async () => {
      await backend.createProposal(baseProposal)
      await backend.createProposal({ ...baseProposal, tenantId: 'team-2' })

      const team1 = await backend.listProposals('team-1')
      expect(team1.length).toBe(1)

      const team2 = await backend.listProposals('team-2')
      expect(team2.length).toBe(1)
    })

    it('filters proposals by status', async () => {
      await backend.createProposal(baseProposal)
      await backend.createProposal({ ...baseProposal, status: 'approved' })

      const pending = await backend.listProposals('team-1', 'pending')
      expect(pending.length).toBe(1)
    })

    it('updates proposal status', async () => {
      const proposal = await backend.createProposal(baseProposal)
      const updated = await backend.updateProposal('team-1', proposal.id, {
        status: 'approved',
        reviewedBy: 'admin',
      })

      expect(updated.status).toBe('approved')
      expect(updated.reviewedBy).toBe('admin')
    })
  })
})
