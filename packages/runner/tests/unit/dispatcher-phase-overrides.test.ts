import { describe, it, expect, vi } from 'vitest'
import { Dispatcher } from '../../src/jobs/dispatcher'
import {
  JobType,
  STATUS_AWAITING_DEVELOPER_INPUT,
  STATUS_CODING,
  STATUS_COMPLETE,
  STATUS_FAILED,
  type Job,
} from '@coro-ai/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'

vi.mock('../../src/jobs/runner', () => ({
  runJob: vi.fn().mockResolvedValue(undefined),
}))

function baseJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-overrides',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { repoSlug: 'svc', serviceName: 'svc' },
    triggerSource: 'cli',
    status: STATUS_AWAITING_DEVELOPER_INPUT,
    phase: 'coding',
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

function buildDispatcherCtx(initialJob: Job) {
  let stored: Job = { ...initialJob }
  const getJob = vi.fn(async () => stored)
  const updateJob = vi.fn(async (_jobId: string, patch: Partial<Job>) => {
    stored = { ...stored, ...patch }
    return stored
  })
  const appendLog = vi.fn(async () => undefined)

  const dispatcher = new Dispatcher({
    stateBackend: {
      getJob,
      updateJob,
      appendLog,
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as never)

  return { dispatcher, getJob, updateJob, appendLog, getStored: () => stored }
}

describe('Dispatcher.setPhaseOverride', () => {
  it('persists a new override entry and logs it', async () => {
    const job = baseJob()
    const { dispatcher, updateJob, appendLog, getStored } = buildDispatcherCtx(job)

    await dispatcher.setPhaseOverride(job.id, 'planning', { model: 'gpt-5-codex', provider: 'openai' })

    expect(updateJob).toHaveBeenCalledWith(job.id, {
      phaseModelOverrides: { planning: { model: 'gpt-5-codex', provider: 'openai' } },
    })
    expect(getStored().phaseModelOverrides).toEqual({
      planning: { model: 'gpt-5-codex', provider: 'openai' },
    })
    expect(appendLog).toHaveBeenCalledWith(
      job.id,
      expect.stringContaining('openai/gpt-5-codex'),
    )
  })

  it('omits provider when not supplied', async () => {
    const job = baseJob()
    const { dispatcher, getStored } = buildDispatcherCtx(job)

    await dispatcher.setPhaseOverride(job.id, 'coding', { model: 'tier:coding' })

    expect(getStored().phaseModelOverrides).toEqual({
      coding: { model: 'tier:coding' },
    })
  })

  it('clears a single phase entry when override is null', async () => {
    const job = baseJob({
      phaseModelOverrides: {
        planning: { model: 'a' },
        coding: { model: 'b' },
      },
    })
    const { dispatcher, getStored } = buildDispatcherCtx(job)

    await dispatcher.setPhaseOverride(job.id, 'planning', null)

    expect(getStored().phaseModelOverrides).toEqual({ coding: { model: 'b' } })
  })

  it('drops the field entirely once the last entry is cleared', async () => {
    const job = baseJob({
      phaseModelOverrides: { planning: { model: 'a' } },
    })
    const { dispatcher, getStored } = buildDispatcherCtx(job)

    await dispatcher.setPhaseOverride(job.id, 'planning', null)

    expect(getStored().phaseModelOverrides).toBeUndefined()
  })

  it('throws on unknown job', async () => {
    const job = baseJob()
    const { dispatcher } = buildDispatcherCtx(job)
    // Override getJob to simulate missing record.
    ;(dispatcher as unknown as { ctx: { stateBackend: { getJob: () => Promise<Job | null> } } }).ctx.stateBackend.getJob =
      vi.fn(async () => null)

    await expect(dispatcher.setPhaseOverride('nope', 'planning', { model: 'x' }))
      .rejects.toThrow(/Unknown job/)
  })
})

describe('Dispatcher.rerunPhase', () => {
  it('persists the override and resumes from the requested phase with a fresh session', async () => {
    const job = baseJob({ status: STATUS_AWAITING_DEVELOPER_INPUT, phase: 'review' })
    const { dispatcher, updateJob, appendLog } = buildDispatcherCtx(job)

    await dispatcher.rerunPhase(job.id, 'planning', { model: 'claude-opus-4-8' })

    // First updateJob: setPhaseOverride.
    expect(updateJob).toHaveBeenNthCalledWith(1, job.id, {
      phaseModelOverrides: { planning: { model: 'claude-opus-4-8' } },
    })
    // Second updateJob: resumeJob's status flip + phase reset.
    const secondCall = updateJob.mock.calls[1]
    expect(secondCall[0]).toBe(job.id)
    expect(secondCall[1]).toMatchObject({
      status: STATUS_CODING,
      phase: 'planning',
    })
    expect(appendLog).toHaveBeenCalledWith(
      job.id,
      expect.stringContaining('Re-running phase "planning"'),
    )
  })

  it('works without an override (re-run with the existing model)', async () => {
    const job = baseJob({ status: STATUS_AWAITING_DEVELOPER_INPUT })
    const { dispatcher, updateJob, getStored } = buildDispatcherCtx(job)

    await dispatcher.rerunPhase(job.id, 'coding')

    // Only the resumeJob updateJob fires — no override persisted.
    expect(updateJob).toHaveBeenCalledTimes(1)
    expect(getStored().phaseModelOverrides).toBeUndefined()
  })

  it('refuses to re-run while the job is currently running', async () => {
    const job = baseJob({ status: STATUS_CODING })
    const { dispatcher, updateJob } = buildDispatcherCtx(job)

    await expect(dispatcher.rerunPhase(job.id, 'coding', { model: 'x' }))
      .rejects.toThrow(/pause it/i)
    expect(updateJob).not.toHaveBeenCalled()
  })

  it('refuses to re-run a fully complete job', async () => {
    const job = baseJob({ status: STATUS_COMPLETE })
    const { dispatcher, updateJob } = buildDispatcherCtx(job)

    await expect(dispatcher.rerunPhase(job.id, 'planning', { model: 'x' }))
      .rejects.toThrow(/Cannot re-run/)
    expect(updateJob).not.toHaveBeenCalled()
  })

  it('allows re-run from a failed/escalated job', async () => {
    const job = baseJob({ status: STATUS_FAILED })
    const { dispatcher, updateJob } = buildDispatcherCtx(job)

    await dispatcher.rerunPhase(job.id, 'planning', { model: 'x' })

    expect(updateJob).toHaveBeenCalled()
  })
})
