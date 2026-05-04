import { describe, it, expect, vi } from 'vitest'
import { Dispatcher } from '../../src/jobs/dispatcher'
import {
  JobType,
  STATUS_AWAITING_DEVELOPER_INPUT,
  STATUS_CODING,
  STATUS_COMPLETE,
  emptyTokenUsage,
  type Job,
} from '../../src/jobs/types'

vi.mock('../../src/jobs/runner', () => ({
  runJob: vi.fn().mockResolvedValue(undefined),
}))

function baseJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-toggle',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { repoSlug: 'svc', serviceName: 'svc' },
    triggerSource: 'cli',
    status: 'coding',
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

describe('Dispatcher.setJobInteractive', () => {
  it('persists the new value and is a no-op when value matches', async () => {
    const job = baseJob({ interactive: false })
    const { dispatcher, updateJob } = buildDispatcherCtx(job)

    const result = await dispatcher.setJobInteractive(job.id, false)
    expect(result.interactive).toBe(false)
    expect(updateJob).not.toHaveBeenCalled()
  })

  it('flips ON without resuming when job is mid-phase', async () => {
    const job = baseJob({ interactive: false, status: 'coding' })
    const { dispatcher, updateJob, appendLog } = buildDispatcherCtx(job)

    const result = await dispatcher.setJobInteractive(job.id, true)
    expect(result.interactive).toBe(true)
    expect(updateJob).toHaveBeenCalledTimes(1)
    expect(updateJob).toHaveBeenCalledWith(job.id, { interactive: true })
    expect(appendLog).toHaveBeenCalledWith(job.id, expect.stringContaining('Interactive mode enabled'))
  })

  it('rejects toggling a stopped (complete) job', async () => {
    const job = baseJob({ interactive: false, status: STATUS_COMPLETE })
    const { dispatcher, updateJob } = buildDispatcherCtx(job)

    await expect(dispatcher.setJobInteractive(job.id, true)).rejects.toThrow(/complete/i)
    expect(updateJob).not.toHaveBeenCalled()
  })

  it('auto-releases a parked checkpoint when toggling OFF', async () => {
    const job = baseJob({
      interactive: true,
      status: STATUS_AWAITING_DEVELOPER_INPUT,
      phase: 'coding',
      awaitingEvent: 'developer-input: approval after coding',
      awaitingNextPhase: 'review',
    })
    const { dispatcher, updateJob, appendLog, getStored } = buildDispatcherCtx(job)

    const result = await dispatcher.setJobInteractive(job.id, false)

    // First call: persist new interactive value.
    expect(updateJob).toHaveBeenNthCalledWith(1, job.id, { interactive: false })
    // Second call: resumeJob's update — clears awaiting + advances phase.
    expect(updateJob).toHaveBeenNthCalledWith(
      2,
      job.id,
      expect.objectContaining({
        status: STATUS_CODING,
        awaitingEvent: undefined,
        awaitingPrId: undefined,
        phase: 'review',
      }),
    )
    expect(appendLog).toHaveBeenCalledWith(job.id, expect.stringContaining('Interactive mode disabled'))
    expect(appendLog).toHaveBeenCalledWith(job.id, expect.stringContaining('Auto-releasing checkpoint park'))
    expect(result.interactive).toBe(false)
    expect(getStored().phase).toBe('review')
  })

  it('does not auto-release a non-checkpoint park (e.g. PR merge wait)', async () => {
    const job = baseJob({
      interactive: true,
      status: 'awaiting-pr-merge',
      phase: 'reviewing',
      awaitingEvent: 'pullrequest:fulfilled',
      awaitingPrId: 42,
    })
    const { dispatcher, updateJob } = buildDispatcherCtx(job)

    await dispatcher.setJobInteractive(job.id, false)

    // Single update call — only the interactive flag patch, no resume.
    expect(updateJob).toHaveBeenCalledTimes(1)
    expect(updateJob).toHaveBeenCalledWith(job.id, { interactive: false })
  })
})
