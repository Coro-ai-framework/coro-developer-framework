import { describe, it, expect, vi } from 'vitest'
import { JobType, type Job, type PhaseUsage } from '@coro-ai/cloud-protocol'
import {
  aggregatePhaseRuns,
  buildJobReport,
  buildJobReportById,
  getJobLogExcerpts,
  JOB_LIST_MAX_LIMIT,
  listJobHistory,
} from '../../src/tools/job-history'
import { createSanitizer } from '../../src/tools/sanitize'
import type { StateBackend } from '../../src/state/backend'
import type { ToolContext } from '../../src/tools/types'
import { makeMockJob, makeMockToolContext } from '../mcp/fixtures'

function phaseRun(phase: string, over: Partial<PhaseUsage> = {}): PhaseUsage {
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

/**
 * Tool context whose state backend serves a fixed job list, with the
 * calling job typed as a retrospective so the gate lets us through.
 */
function ctxWithHistory(jobs: Job[], callerOverrides: Record<string, unknown> = {}): ToolContext {
  const byId = new Map(jobs.map(job => [job.id, job]))
  const stateBackend = {
    listJobs: vi.fn().mockResolvedValue(jobs),
    getJob: vi.fn().mockImplementation(async (id: string) => byId.get(id) ?? null),
    getLog: vi.fn().mockResolvedValue([]),
  } as unknown as StateBackend

  return makeMockToolContext({
    job: makeMockJob({
      id: 'retro-1',
      type: JobType.Retrospective,
      workflowPath: 'workflows/retrospective/workflow.md',
      params: {},
      ...callerOverrides,
    }) as unknown as Job,
    stateBackend,
    settings: {
      paths: { workingDir: '/tmp/work', coroIntelligenceDir: '/tmp/intel' },
      bitbucket: { workspace: 'acme' },
      github: { owner: 'acme-gh' },
    } as unknown as ToolContext['settings'],
  })
}

function historyJob(id: string, over: Record<string, unknown> = {}): Job {
  return makeMockJob({
    id,
    type: JobType.Job,
    status: 'complete',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T01:00:00Z',
    params: { repoSlug: 'billing-api' },
    ...over,
  }) as unknown as Job
}

describe('aggregatePhaseRuns', () => {
  it('collapses repeated phase snapshots into a run count and summed cost', () => {
    const aggregated = aggregatePhaseRuns([
      phaseRun('planning'),
      phaseRun('coding', { costUsd: 2, durationMs: 2000, numTurns: 10 }),
      phaseRun('coding', { costUsd: 3, durationMs: 3000, numTurns: 12, model: 'claude-other' }),
    ])

    expect(aggregated).toEqual([
      { phase: 'planning', runs: 1, costUsd: 1, durationMs: 1000, turns: 4, models: ['claude-test'] },
      { phase: 'coding', runs: 2, costUsd: 5, durationMs: 5000, turns: 22, models: ['claude-test', 'claude-other'] },
    ])
  })

  it('tolerates snapshots missing optional metrics', () => {
    const aggregated = aggregatePhaseRuns([
      { phase: 'coding', model: '' } as unknown as PhaseUsage,
    ])
    expect(aggregated[0]).toMatchObject({ runs: 1, costUsd: 0, turns: 0, models: [] })
  })
})

describe('the retrospective gate', () => {
  const historyTools = [
    ['list_jobs', (ctx: ToolContext) => listJobHistory({}, ctx)],
    ['get_job_report', (ctx: ToolContext) => buildJobReportById({ jobId: 'job-a' }, ctx)],
    ['get_job_log_excerpts', (ctx: ToolContext) => getJobLogExcerpts({ jobId: 'job-a' }, ctx)],
  ] as const

  it.each(historyTools)('rejects %s from an ordinary job', async (name, call) => {
    const ctx = ctxWithHistory([historyJob('job-a')], { type: JobType.Job })
    await expect(call(ctx)).rejects.toThrow(
      new RegExp(`${name} is only available to retrospective jobs`),
    )
  })
})

describe('listJobHistory', () => {
  it('returns implementation jobs newest-first with loop signals', async () => {
    const ctx = ctxWithHistory([
      historyJob('job-old', { createdAt: '2026-01-01T00:00:00Z' }),
      historyJob('job-new', {
        createdAt: '2026-02-01T00:00:00Z',
        updatedAt: '2026-02-01T00:30:00Z',
        workItems: [{ name: 'wi-1', status: 'complete', loopCount: 3 }],
        phaseUsage: [phaseRun('coding'), phaseRun('coding'), phaseRun('evaluation')],
        tokenUsage: {
          inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0, totalCostUsd: 4.25,
        },
      }),
    ])

    const result = await listJobHistory({}, ctx)

    expect(result.jobs.map(j => j.id)).toEqual(['job-new', 'job-old'])
    expect(result.jobs[0]).toMatchObject({
      costUsd: 4.25,
      durationMs: 30 * 60 * 1000,
      maxLoopCount: 3,
      loopedPhases: [{ phase: 'coding', runs: 2 }],
      repo: 'repo-A',
    })
  })

  it('excludes the calling retrospective and other job types by default', async () => {
    const ctx = ctxWithHistory([
      historyJob('job-a'),
      makeMockJob({ id: 'retro-1', type: JobType.Retrospective }) as unknown as Job,
      makeMockJob({ id: 'retro-0', type: JobType.Retrospective }) as unknown as Job,
    ])

    const result = await listJobHistory({}, ctx)
    expect(result.jobs.map(j => j.id)).toEqual(['job-a'])
  })

  it('lists past retrospectives under the retrospective scope', async () => {
    const ctx = ctxWithHistory([
      historyJob('job-a'),
      makeMockJob({ id: 'retro-0', type: JobType.Retrospective }) as unknown as Job,
    ])

    const result = await listJobHistory({ scope: 'retrospective' }, ctx)
    expect(result.scope).toBe('retrospective')
    expect(result.jobs.map(j => j.id)).toEqual(['retro-0'])
  })

  it('filters by status and since, and reports the unpaged total', async () => {
    const ctx = ctxWithHistory([
      historyJob('job-old', { createdAt: '2026-01-01T00:00:00Z', status: 'escalated' }),
      historyJob('job-new', { createdAt: '2026-03-01T00:00:00Z', status: 'escalated' }),
      historyJob('job-done', { createdAt: '2026-03-02T00:00:00Z', status: 'complete' }),
    ])

    const result = await listJobHistory({ status: 'escalated', since: '2026-02-01T00:00:00Z' }, ctx)
    expect(result.jobs.map(j => j.id)).toEqual(['job-new'])
    expect(result.total).toBe(1)
  })

  it('caps the page size and rejects an unparseable since', async () => {
    const jobs = Array.from({ length: 130 }, (_, i) =>
      historyJob(`job-${i}`, { createdAt: new Date(2026, 0, 1, i).toISOString() }),
    )
    const ctx = ctxWithHistory(jobs)

    const capped = await listJobHistory({ limit: 500 }, ctx)
    expect(capped.returned).toBe(JOB_LIST_MAX_LIMIT)
    expect(capped.total).toBe(130)

    await expect(listJobHistory({ since: 'last tuesday' }, ctx)).rejects.toThrow(/must be an ISO timestamp/)
  })
})

describe('buildJobReport', () => {
  const job = historyJob('job-a', {
    status: 'escalated',
    phase: 'coding',
    escalationMessage: 'could not clone billing-api for PROJ-77',
    workItems: [{ name: 'add billing-api endpoint', status: 'escalated', loopCount: 4 }],
    phaseUsage: [phaseRun('coding'), phaseRun('coding', { costUsd: 2 })],
    insights: [{
      phase: 'coding', category: 'tooling', summary: 'clone of billing-api failed',
      detail: 'd', status: 'approved' as const,
    }],
    prMappings: [{
      prId: 7, workItem: 'wi', repoSlug: 'billing-api',
      openedAt: '2026-01-01T00:00:00Z', mergedAt: '2026-01-01T02:00:00Z',
    }],
    rateLimitInfo: { provider: 'anthropic', kind: 'rate-limit', resumeAt: 0, retryAttempt: 2, source: 'x' },
  })

  const sanitizer = createSanitizer({ repoSlugs: ['billing-api'], orgs: [] })

  it('sanitises every free-text surface', () => {
    const report = buildJobReport(job, sanitizer)

    expect(report.escalationMessage).toBe('could not clone repo-A for ticket-ref-1')
    expect(report.workItems[0].name).toBe('add repo-A endpoint')
    expect(report.insights[0].summary).toBe('clone of repo-A failed')
    expect(report.repo).toBe('repo-A')
    expect(sanitizer.findLeaks(JSON.stringify(report))).toEqual([])
  })

  it('keeps raw identifiers when no sanitizer is supplied', () => {
    const report = buildJobReport(job, null)
    expect(report.escalationMessage).toContain('billing-api')
    expect(report.repo).toBe('billing-api')
  })

  it('surfaces loops, escalation, rate-limit retries, and PR latency', () => {
    const report = buildJobReport(job, sanitizer)

    expect(report.loopedPhases).toEqual([{ phase: 'coding', runs: 2 }])
    expect(report.escalated).toBe(true)
    expect(report.rateLimitRetries).toBe(2)
    expect(report.prs[0].timeToMergeMs).toBe(2 * 60 * 60 * 1000)
  })

  it('prefers user-edited insight text', () => {
    const edited = historyJob('job-b', {
      insights: [{
        phase: 'coding', category: 'tooling', summary: 'original', detail: 'd',
        editedSummary: 'reworded by developer', status: 'approved' as const,
      }],
    })
    expect(buildJobReport(edited, sanitizer).insights[0].summary).toBe('reworded by developer')
  })
})

describe('buildJobReportById', () => {
  it('errors clearly on an unknown job id', async () => {
    const ctx = ctxWithHistory([historyJob('job-a')])
    await expect(buildJobReportById({ jobId: 'nope' }, ctx)).rejects.toThrow(/no job found with id "nope"/)
  })
})

describe('getJobLogExcerpts', () => {
  const lines = [
    '2026-01-01T00:00:00Z [artifact] coding/plan-md: Plan',
    '2026-01-01T00:00:01Z [error] scm_get_pr_status failed for billing-api',
    '2026-01-01T00:00:02Z assistant text nobody needs',
    '2026-01-01T00:00:03Z [warning] retrying clone',
    '2026-01-01T00:00:04Z [phase-end] tool_use counts — mcp__coro__*: 12, built-in: 4',
  ]

  function ctxWithLog(logLines: string[]): ToolContext {
    const ctx = ctxWithHistory([historyJob('job-a')])
    ;(ctx.stateBackend.getLog as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(logLines)
    return ctx
  }

  it('keeps only error-ish lines by default and sanitises them', async () => {
    const result = await getJobLogExcerpts({ jobId: 'job-a' }, ctxWithLog(lines))

    expect(result.returned).toBe(3)
    expect(result.lines[0]).toContain('[error] scm_get_pr_status failed for repo-A')
    expect(result.lines.some(l => l.includes('assistant text'))).toBe(false)
  })

  it('honours a custom pattern and returns the tail within the limit', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `[error] failure ${i}`)
    const result = await getJobLogExcerpts({ jobId: 'job-a', pattern: 'failure', limit: 3 }, ctxWithLog(many))

    expect(result.matched).toBe(20)
    expect(result.lines).toEqual(['[error] failure 17', '[error] failure 18', '[error] failure 19'])
  })

  it('truncates very long lines', async () => {
    const result = await getJobLogExcerpts({ jobId: 'job-a' }, ctxWithLog([`[error] ${'x'.repeat(900)}`]))
    expect(result.lines[0]).toHaveLength(401)
    expect(result.lines[0].endsWith('…')).toBe(true)
  })

  it('rejects an invalid regex instead of throwing raw', async () => {
    await expect(
      getJobLogExcerpts({ jobId: 'job-a', pattern: '([' }, ctxWithLog(lines)),
    ).rejects.toThrow(/invalid pattern/)
  })
})
