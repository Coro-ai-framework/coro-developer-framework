import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Dispatcher } from '../../src/jobs/dispatcher'
import {
  JobType,
  STATUS_QUEUED,
  type Investigation,
  type Job,
  type JobInput,
} from '@coro-ai/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'
import { PLAN_CONTEXT_DIR, PLAN_FINDINGS_FILE } from '../../src/jobs/plan-context'

vi.mock('../../src/jobs/runner', () => ({
  runJob: vi.fn().mockResolvedValue(undefined),
}))

function makeInvestigation(): Investigation {
  return {
    id: 'inv-dispatch-1',
    title: 'Rate limit',
    status: 'active',
    items: [],
    turns: [],
    modelChoice: { provider: 'anthropic', model: 'claude' },
    readiness: { state: 'ready', openQuestions: [], note: 'clear' },
    findings: '## Decode path\nThe handler is stateless.',
    turnCount: 1,
    tokens: 20,
    contextUsed: 20,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: {},
    triggerSource: 'cli',
    status: STATUS_QUEUED,
    phase: 'spec-writing',
    currentWorkItem: null,
    workItems: [],
    workItemLoopCount: 0,
    prMappings: [],
    interactive: false,
    artifacts: [],
    insights: [],
    tokenUsage: emptyTokenUsage(),
    phaseUsage: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeBackend(opts: {
  investigation?: Investigation | null
  investigationThrows?: boolean
}) {
  const jobs = new Map<string, Job>()
  const investigations = new Map<string, Investigation>()
  if (opts.investigation) investigations.set(opts.investigation.id, opts.investigation)

  return {
    jobs,
    createJob: vi.fn(async (input: JobInput) => {
      const job = makeJob({ params: input.params, workflowPath: input.workflowPath })
      jobs.set(job.id, job)
      return job
    }),
    getJob: vi.fn(async (id: string) => jobs.get(id) ?? null),
    updateJob: vi.fn(async (id: string, patch: Partial<Job>) => {
      const current = jobs.get(id)
      if (!current) throw new Error(`updateJob: missing ${id}`)
      const next = { ...current, ...patch }
      jobs.set(id, next)
      return next
    }),
    appendLog: vi.fn(async () => undefined),
    getInvestigation: vi.fn(async (id: string) => {
      if (opts.investigationThrows) throw new Error('investigation store down')
      return investigations.get(id) ?? null
    }),
  }
}

describe('Dispatcher.dispatch — plan context', () => {
  let workingDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coro-dispatch-plan-'))
  })

  afterEach(async () => {
    await fs.rm(workingDir, { recursive: true, force: true })
  })

  function dispatcher(backend: ReturnType<typeof makeBackend>) {
    return new Dispatcher({
      stateBackend: backend,
      settings: { paths: { coroIntelligenceDir: '/intel', workingDir, baseLayerDir: '/base' } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      tenantContext: { tenantId: 'solo', kind: 'solo' as const },
      plugins: { all: () => [] },
    } as never)
  }

  it('writes plan/findings.md, sets planContextDir, and appends an artifact', async () => {
    const investigation = makeInvestigation()
    const backend = makeBackend({ investigation })
    const job = await dispatcher(backend).dispatch({
      type: 'job',
      workflowPath: 'workflows/job/workflow.md',
      triggerSource: 'cli',
      params: { investigationId: investigation.id, repo: 'org/svc' },
    })

    expect(job.params['planContextDir']).toBe(PLAN_CONTEXT_DIR)
    expect(job.artifacts).toHaveLength(1)
    expect(job.artifacts[0]).toMatchObject({
      kind: 'plan-findings-md',
      title: 'Plan-mode investigation findings',
      phase: 'spec-writing',
      createdBy: 'plan-mode',
      data: {
        path: `${PLAN_CONTEXT_DIR}/${PLAN_FINDINGS_FILE}`,
        investigationId: investigation.id,
      },
    })
    const written = await fs.readFile(
      path.join(workingDir, job.id, PLAN_CONTEXT_DIR, PLAN_FINDINGS_FILE),
      'utf8',
    )
    expect(written).toContain('## Decode path')
  })

  it('does nothing when investigationId is absent', async () => {
    const backend = makeBackend({})
    const job = await dispatcher(backend).dispatch({
      type: 'job',
      workflowPath: 'workflows/job/workflow.md',
      triggerSource: 'cli',
      params: { repo: 'org/svc' },
    })
    expect(job.params['planContextDir']).toBeUndefined()
    expect(job.artifacts).toEqual([])
    expect(backend.getInvestigation).not.toHaveBeenCalled()
    await expect(fs.access(path.join(workingDir, job.id, PLAN_CONTEXT_DIR))).rejects.toThrow()
  })

  it('still dispatches when getInvestigation throws', async () => {
    const backend = makeBackend({ investigationThrows: true })
    const job = await dispatcher(backend).dispatch({
      type: 'job',
      workflowPath: 'workflows/job/workflow.md',
      triggerSource: 'cli',
      params: { investigationId: 'inv-dispatch-1' },
    })
    expect(job.id).toBe('job-1')
    expect(job.params['planContextDir']).toBeUndefined()
    expect(job.artifacts).toEqual([])
  })
})
