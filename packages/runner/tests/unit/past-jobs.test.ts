import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { JobType, type Job } from '@coro-ai/cloud-protocol'
import {
  getPastJob,
  listPastJobFiles,
  listPastJobs,
  readPastJobArtifact,
  readPastJobFile,
} from '../../src/intake/past-jobs'
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

const planArtifact = {
  id: 'art-plan',
  phase: 'planning',
  kind: 'plan-md',
  title: 'Plan',
  data: { path: 'plan.md' },
  createdBy: 'planner',
  createdAt: '2026-01-01T00:30:00Z',
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

  it('returns a slim catalog without file bodies or phase-run dumps', async () => {
    await fs.mkdir(path.join(tmp, 'job-1'), { recursive: true })
    const target = job('job-1', {
      workItems: [{ name: 'surface-failure-reasons', status: 'complete', loopCount: 1 }],
      artifacts: [
        planArtifact,
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
      { jobId: 'job-1' },
      { stateBackend: backendWith([target]), workingDir: tmp },
    )
    expect(result.summary).toMatchObject({
      id: 'job-1',
      repo: 'billing-api',
      description: 'Add rate limiting',
    })
    expect(result.summary.workItems).toEqual([
      { name: 'surface-failure-reasons', status: 'complete' },
    ])
    expect(result.workspaceAvailable).toBe(true)
    expect(result.artifacts).toEqual([
      {
        id: 'art-plan',
        phase: 'planning',
        kind: 'plan-md',
        title: 'Plan',
        path: 'plan.md',
      },
      {
        id: 'art-pr',
        phase: 'review',
        kind: 'pr-link',
        title: 'PR',
        data: { url: 'https://example.com/pr/7', prId: 7 },
      },
    ])
    expect(result).not.toHaveProperty('contents')
    expect(result.summary).not.toHaveProperty('phaseRuns')
    expect(result.summary).not.toHaveProperty('toolHistogram')
  })
})

describe('readPastJobArtifact', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-past-art-'))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('reads one artefact file and pages with offset', async () => {
    const jobDir = path.join(tmp, 'job-1')
    await fs.mkdir(jobDir, { recursive: true })
    await fs.writeFile(path.join(jobDir, 'plan.md'), 'ABCDEFGHIJ', 'utf-8')
    const target = job('job-1', { artifacts: [planArtifact] })
    const first = await readPastJobArtifact(
      { jobId: 'job-1', artifactId: 'art-plan', limit: 4 },
      { stateBackend: backendWith([target]), workingDir: tmp },
    )
    expect(first).toMatchObject({
      text: 'ABCD',
      truncated: true,
      nextOffset: 4,
      totalChars: 10,
    })
    const rest = await readPastJobArtifact(
      { jobId: 'job-1', artifactId: 'art-plan', offset: 4, limit: 10 },
      { stateBackend: backendWith([target]), workingDir: tmp },
    )
    expect(rest).toMatchObject({ text: 'EFGHIJ', truncated: false })
  })

  it('soft-fails when the artefact file is missing', async () => {
    const target = job('job-missing', { artifacts: [planArtifact] })
    const result = await readPastJobArtifact(
      { jobId: 'job-missing', artifactId: 'art-plan' },
      { stateBackend: backendWith([target]), workingDir: tmp },
    )
    expect(result).toMatchObject({ missing: true, path: 'plan.md' })
    expect(result.text).toBeUndefined()
  })

  it('rejects a path that escapes the job working directory without leaking contents', async () => {
    await fs.writeFile(path.join(tmp, 'secret.txt'), 'should-not-leak', 'utf-8')
    const target = job('job-escape', {
      artifacts: [{ ...planArtifact, data: { path: '../secret.txt' } }],
    })
    const result = await readPastJobArtifact(
      { jobId: 'job-escape', artifactId: 'art-plan' },
      { stateBackend: backendWith([target]), workingDir: tmp },
    )
    expect(result).toMatchObject({ missing: true, path: '../secret.txt' })
    expect(result.text).toBeUndefined()
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
    const result = await readPastJobArtifact(
      { jobId: 'job-pr', artifactId: 'art-pr' },
      { stateBackend: backendWith([target]), workingDir: tmp },
    )
    expect(result.text).toContain('https://example.com/pr/7')
    expect(result.missing).toBeUndefined()
  })
})

describe('listPastJobFiles / readPastJobFile', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-past-files-'))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('lists the job workspace and reads a file, skipping .git', async () => {
    const jobDir = path.join(tmp, 'job-1')
    await fs.mkdir(path.join(jobDir, 'src'), { recursive: true })
    await fs.mkdir(path.join(jobDir, '.git'), { recursive: true })
    await fs.writeFile(path.join(jobDir, 'plan.md'), '# Plan', 'utf-8')
    await fs.writeFile(path.join(jobDir, 'src', 'api.go'), 'package api', 'utf-8')
    const target = job('job-1')
    const listed = await listPastJobFiles(
      { jobId: 'job-1' },
      { stateBackend: backendWith([target]), workingDir: tmp },
    )
    expect(listed.entries.map(e => e.path).sort()).toEqual(['plan.md', 'src'])
    const nested = await listPastJobFiles(
      { jobId: 'job-1', path: 'src' },
      { stateBackend: backendWith([target]), workingDir: tmp },
    )
    expect(nested.entries).toEqual([{ path: 'src/api.go', type: 'file', size: Buffer.byteLength('package api') }])
    const read = await readPastJobFile(
      { jobId: 'job-1', path: 'src/api.go' },
      { stateBackend: backendWith([target]), workingDir: tmp },
    )
    expect(read.text).toBe('package api')
  })

  it('flags a missing workspace instead of throwing', async () => {
    const target = job('job-gone')
    const listed = await listPastJobFiles(
      { jobId: 'job-gone' },
      { stateBackend: backendWith([target]), workingDir: tmp },
    )
    expect(listed.missing).toBe(true)
    const read = await readPastJobFile(
      { jobId: 'job-gone', path: 'plan.md' },
      { stateBackend: backendWith([target]), workingDir: tmp },
    )
    expect(read.missing).toBe(true)
  })
})
