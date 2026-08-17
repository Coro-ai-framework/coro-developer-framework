import { describe, expect, it } from 'vitest'
import { JobType, type Job } from '@coro-ai/cloud-protocol'
import {
  clusterWindow,
  detectAntiPatterns,
  getJobTraceSummary,
  metricValue,
  scorePriorRemedies,
} from '../../src/tools/job-trace'
import type { StateBackend } from '../../src/state/backend'
import type { ToolContext } from '../../src/tools/types'
import { makeMockJob, makeMockToolContext } from '../mcp/fixtures'

function phaseRun(phase: string, over: Record<string, unknown> = {}) {
  return {
    phase,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 1,
    durationMs: 1000,
    durationApiMs: 900,
    numTurns: 4,
    model: 'claude-test',
    ...over,
  }
}

function ctxWithJobs(jobs: Job[], caller: Record<string, unknown> = {}): ToolContext {
  const byId = new Map(jobs.map(job => [job.id, job]))
  const stateBackend = {
    listJobs: async () => jobs,
    getJob: async (id: string) => byId.get(id) ?? null,
    getLog: async () => [],
  } as unknown as StateBackend

  return makeMockToolContext({
    job: makeMockJob({
      id: 'retro-1',
      type: JobType.Retrospective,
      workflowPath: 'workflows/retrospective/workflow.md',
      params: { jobWindow: 10 },
      ...caller,
    }) as unknown as Job,
    stateBackend,
    settings: {
      paths: { workingDir: '/tmp/work', coroIntelligenceDir: '/tmp/intel' },
      bitbucket: { workspace: 'acme' },
      github: { owner: 'acme-gh' },
    } as unknown as ToolContext['settings'],
  })
}

function job(id: string, over: Record<string, unknown> = {}): Job {
  return makeMockJob({
    id,
    type: JobType.Job,
    status: 'complete',
    workflowPath: 'workflows/job/workflow.md',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T01:00:00Z',
    params: { repoSlug: 'billing-api' },
    ...over,
  }) as unknown as Job
}

describe('clusterWindow', () => {
  it('is retrospective-only', async () => {
    const ctx = ctxWithJobs([job('job-a')], { type: JobType.Job })
    await expect(clusterWindow({}, ctx)).rejects.toThrow(/only available to retrospective jobs/)
  })

  it('groups tool failures, insights, and cost outliers', async () => {
    const cheap = job('job-cheap', {
      tokenUsage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalCostUsd: 1 },
    })
    const cheap2 = job('job-cheap-2', {
      createdAt: '2026-01-02T00:00:00Z',
      tokenUsage: { inputTokens: 110, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalCostUsd: 1.1 },
    })
    const cheap3 = job('job-cheap-3', {
      createdAt: '2026-01-03T00:00:00Z',
      tokenUsage: { inputTokens: 90, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalCostUsd: 0.9 },
    })
    const expensive = job('job-expensive', {
      createdAt: '2026-02-01T00:00:00Z',
      tokenUsage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalCostUsd: 8 },
      insights: [{ phase: 'coding', category: 'sandbox-quirk', summary: 'EPERM on cache', detail: 'd' }],
      phaseUsage: [
        phaseRun('coding', {
          toolLedger: [
            { toolName: 'Bash', success: false, durationMs: 10, errorClass: 'eperm' },
            { toolName: 'Bash', success: false, durationMs: 10, errorClass: 'eperm' },
          ],
        }),
      ],
    })
    const ctx = ctxWithJobs([cheap, cheap2, cheap3, expensive])

    const clustered = await clusterWindow({ limit: 10 }, ctx)
    expect(clustered.window.jobCount).toBe(4)
    expect(clustered.insights[0]).toMatchObject({ key: 'sandbox-quirk', count: 1, jobIds: ['job-expensive'] })
    expect(clustered.toolFailures[0]).toMatchObject({ key: 'Bash|eperm', jobIds: ['job-expensive'] })
    expect(clustered.costOutliers.map(row => row.jobId)).toContain('job-expensive')
  })
})

describe('getJobTraceSummary', () => {
  it('labels same-tool-fail and returns a capped event skeleton', async () => {
    const target = job('job-a', {
      phaseUsage: [
        phaseRun('coding', {
          workItem: 'wi-1',
          toolLedger: [
            { toolName: 'Bash', success: false, durationMs: 1, errorClass: 'eperm' },
            { toolName: 'Bash', success: false, durationMs: 1, errorClass: 'eperm' },
            { toolName: 'Bash', success: false, durationMs: 1, errorClass: 'eperm' },
          ],
        }),
      ],
    })
    const ctx = ctxWithJobs([target])
    const summary = await getJobTraceSummary({ jobId: 'job-a' }, ctx)
    expect(summary.antiPatterns).toContain('same-tool-fail')
    expect(summary.events.some(event => event.kind === 'tool-fail' && event.toolName === 'Bash')).toBe(true)
    expect(summary.toolHistogram[0]).toMatchObject({ toolName: 'Bash', failures: 3 })
  })
})

describe('detectAntiPatterns', () => {
  it('flags a coding phase that wrote without running a test', () => {
    const target = job('job-a', {
      phaseUsage: [
        phaseRun('coding', {
          toolLedger: [
            { toolName: 'Edit', success: true, durationMs: 5 },
            { toolName: 'Write', success: true, durationMs: 5 },
          ],
        }),
      ],
    })
    expect(detectAntiPatterns(target)).toContain('verify-skip')
  })
})

describe('scorePriorRemedies', () => {
  it('marks a prior finding without a predicted metric as unverifiable', () => {
    const retro = makeMockJob({
      id: 'retro-0',
      type: JobType.Retrospective,
      createdAt: '2026-01-01T00:00:00Z',
      artifacts: [{
        id: 'art-1',
        phase: 'analysis',
        kind: 'retrospective-report',
        title: 'report',
        data: {
          findings: [{
            id: 'finding-1',
            title: 'Coder loops on tests',
            category: 'runner-code',
            severity: 'high',
            evidence: [{ jobId: 'job-a', detail: 'rework' }],
          }],
        },
        createdBy: 'analysis',
        createdAt: '2026-01-01T00:00:00Z',
      }, {
        id: 'art-2',
        phase: 'shipping',
        kind: 'retrospective-outcome',
        title: 'outcome',
        data: { outcomes: [{ findingId: 'finding-1', destination: 'upstream-code' }] },
        createdBy: 'shipping',
        createdAt: '2026-01-01T01:00:00Z',
      }],
    }) as unknown as Job

    const scores = scorePriorRemedies([retro], [job('job-a')])
    expect(scores[0]).toMatchObject({ findingId: 'finding-1', score: 'unverifiable' })
  })

  it('scores an eliminate metric as gone when the window is clean', () => {
    const retro = makeMockJob({
      id: 'retro-0',
      type: JobType.Retrospective,
      createdAt: '2026-01-01T00:00:00Z',
      artifacts: [{
        id: 'art-1',
        phase: 'analysis',
        kind: 'retrospective-report',
        title: 'report',
        data: {
          findings: [{
            id: 'finding-1',
            title: 'Coder loops on tests',
            category: 'runner-code',
            severity: 'high',
            evidence: [{ jobId: 'job-a', detail: 'rework' }],
            predictedMetric: { name: 'coding.reworkRuns', direction: 'eliminate', baseline: 4 },
          }],
        },
        createdBy: 'analysis',
        createdAt: '2026-01-01T00:00:00Z',
      }, {
        id: 'art-2',
        phase: 'shipping',
        kind: 'retrospective-outcome',
        title: 'outcome',
        data: { outcomes: [{ findingId: 'finding-1', destination: 'upstream-code' }] },
        createdBy: 'shipping',
        createdAt: '2026-01-01T01:00:00Z',
      }],
    }) as unknown as Job

    expect(scorePriorRemedies([retro], [job('job-clean')])[0]).toMatchObject({ score: 'gone' })
    expect(metricValue([job('job-loop', {
      phaseUsage: [
        phaseRun('coding', { workItem: 'wi-1' }),
        phaseRun('coding', { workItem: 'wi-1' }),
      ],
    })], 'coding.reworkRuns')).toBe(1)
  })
})
