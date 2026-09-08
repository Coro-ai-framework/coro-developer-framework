import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { JobType, type Job } from '@coro-ai/cloud-protocol'
import { getPastJob, listPastJobs } from '../../src/intake/past-jobs'
import type { StateBackend } from '../../src/state/backend'
import { makeMockJob } from '../mcp/fixtures'

function job(id: string, over: Record<string, unknown> = {}): Job {
  return makeMockJob({
    id,
    type: JobType.Job,
    status: 'complete',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T01:00:00Z',
    params: { repoSlug: 'billing-api', description: 'Add rate limiting' },
    ...over,
  }) as unknown as Job
}

function backendWith(jobs: Job[]): Pick<StateBackend, 'listJobs' | 'getJob'> {
  const byId = new Map(jobs.map(j => [j.id, j]))
  return {
    listJobs: vi.fn().mockResolvedValue(jobs),
    getJob: vi.fn().mockImplementation(async (id: string) => byId.get(id) ?? null),
  }
}

describe('listPastJobs', () => {
  it('returns implementation jobs newest-first and skips retrospectives', async () => {
    const older = job('job-old', { createdAt: '2026-01-01T00:00:00Z' })
    const newer = job('job-new', { createdAt: '2026-02-01T00:00:00Z' })
    const retro = job('retro-1', {
      type: JobType.Retrospective,
      createdAt: '2026-03-01T00:00:00Z',
    })
    const result = await listPastJobs({}, { stateBackend: backendWith([older, newer, retro]) })
    expect(result.total).toBe(2)
    expect(result.jobs.map(j => j.id)).toEqual(['job-new', 'job-old'])
    expect(result.jobs[0]?.description).toBe('Add rate limiting')
    expect(result.jobs[0]?.repo).toBe('billing-api')
  })

  it('filters by repo, status, and since', async () => {
    const matching = job('job-match', {
      status: 'complete',
      createdAt: '2026-06-01T00:00:00Z',
      params: { repoSlug: 'org/billing-api', description: 'done' },
    })
    const otherRepo = job('job-other-repo', {
      createdAt: '2026-06-02T00:00:00Z',
      params: { repoSlug: 'payments-api' },
    })
    const otherStatus = job('job-failed', {
      status: 'failed',
      createdAt: '2026-06-03T00:00:00Z',
      params: { repoSlug: 'billing-api' },
    })
    const tooOld = job('job-old', {
      createdAt: '2026-01-01T00:00:00Z',
      params: { repoSlug: 'billing-api' },
    })
    const result = await listPastJobs(
      { repo: 'billing-api', status: 'complete', since: '2026-05-01T00:00:00Z' },
      { stateBackend: backendWith([matching, otherRepo, otherStatus, tooOld]) },
    )
    expect(result.jobs.map(j => j.id)).toEqual(['job-match'])
  })
})

describe('getPastJob', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-past-jobs-'))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('returns summary, artefacts, and file content for default kinds', async () => {
    const jobDir = path.join(tmp, 'job-1')
    await fs.mkdir(jobDir, { recursive: true })
    await fs.writeFile(path.join(jobDir, 'plan.md'), '# Implementation plan\n- rate limit', 'utf-8')
    const target = job('job-1', {
      artifacts: [
        {
          id: 'art-plan',
          phase: 'planning',
          kind: 'plan-md',
          title: 'Plan',
          data: { path: 'plan.md' },
          createdBy: 'planner',
          createdAt: '2026-01-01T00:30:00Z',
        },
        {
          id: 'art-other',
          phase: 'coding',
          kind: 'json',
          title: 'Opaque',
          data: { note: 'skip by default' },
          createdBy: 'coder',
          createdAt: '2026-01-01T00:40:00Z',
        },
      ],
    })
    const result = await getPastJob(
      { jobId: 'job-1' },
      { stateBackend: backendWith([target]), workingDir: tmp },
    )
    expect(result.summary.id).toBe('job-1')
    expect(result.summary.repo).toBe('billing-api')
    expect(result.artifacts).toHaveLength(2)
    expect(result.contents).toHaveLength(1)
    expect(result.contents?.[0]).toMatchObject({
      artifactId: 'art-plan',
      kind: 'plan-md',
      path: 'plan.md',
      text: '# Implementation plan\n- rate limit',
    })
  })

  it('soft-fails when the artefact file is missing', async () => {
    const target = job('job-missing', {
      artifacts: [
        {
          id: 'art-plan',
          phase: 'planning',
          kind: 'plan-md',
          title: 'Plan',
          data: { path: 'gone.md' },
          createdBy: 'planner',
          createdAt: '2026-01-01T00:30:00Z',
        },
      ],
    })
    const result = await getPastJob(
      { jobId: 'job-missing' },
      { stateBackend: backendWith([target]), workingDir: tmp },
    )
    expect(result.contents?.[0]).toMatchObject({
      artifactId: 'art-plan',
      missing: true,
      path: 'gone.md',
    })
    expect(result.contents?.[0]?.text).toBeUndefined()
  })

  it('rejects a path that escapes the job working directory without leaking contents', async () => {
    await fs.writeFile(path.join(tmp, 'secret.txt'), 'should-not-leak', 'utf-8')
    const target = job('job-escape', {
      artifacts: [
        {
          id: 'art-plan',
          phase: 'planning',
          kind: 'plan-md',
          title: 'Plan',
          data: { path: '../secret.txt' },
          createdBy: 'planner',
          createdAt: '2026-01-01T00:30:00Z',
        },
      ],
    })
    const result = await getPastJob(
      { jobId: 'job-escape' },
      { stateBackend: backendWith([target]), workingDir: tmp },
    )
    expect(result.contents?.[0]).toMatchObject({ missing: true, path: '../secret.txt' })
    expect(result.contents?.[0]?.text).toBeUndefined()
  })

  it('returns inline artefact data when there is no path', async () => {
    const target = job('job-pr', {
      artifacts: [
        {
          id: 'art-pr',
          phase: 'review',
          kind: 'pr-link',
          title: 'PR',
          data: { url: 'https://example.com/pr/7', prId: 7 },
          createdBy: 'reviewer',
          createdAt: '2026-01-01T00:50:00Z',
        },
      ],
    })
    const result = await getPastJob(
      { jobId: 'job-pr' },
      { stateBackend: backendWith([target]), workingDir: tmp },
    )
    expect(result.contents?.[0]?.text).toContain('https://example.com/pr/7')
    expect(result.contents?.[0]?.missing).toBeUndefined()
  })

  it('omits contents when includeContent is false', async () => {
    const target = job('job-meta', {
      artifacts: [
        {
          id: 'art-plan',
          phase: 'planning',
          kind: 'plan-md',
          title: 'Plan',
          data: { path: 'plan.md' },
          createdBy: 'planner',
          createdAt: '2026-01-01T00:30:00Z',
        },
      ],
    })
    const result = await getPastJob(
      { jobId: 'job-meta', includeContent: false },
      { stateBackend: backendWith([target]), workingDir: tmp },
    )
    expect(result.artifacts).toHaveLength(1)
    expect(result.contents).toBeUndefined()
  })
})
