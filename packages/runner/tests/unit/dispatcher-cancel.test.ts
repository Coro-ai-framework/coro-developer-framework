import { describe, it, expect, vi } from 'vitest'
import { Dispatcher } from '../../src/jobs/dispatcher'
import {
  JobType,
  STATUS_AWAITING_PR_MERGE,
  STATUS_CANCELLED,
  STATUS_COMPLETE,
  type Job,
} from '@coro-ai/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'

vi.mock('../../src/jobs/runner', () => ({
  runJob: vi.fn().mockResolvedValue(undefined),
}))

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-cancel-1',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { repoSlug: 'svc', serviceName: 'svc' },
    triggerSource: 'cli',
    status: STATUS_AWAITING_PR_MERGE,
    phase: 'review',
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
    awaitingEvent: 'pullrequest:fulfilled',
    awaitingPrId: 42,
    awaitingNextPhase: 'evaluation',
    approvedAdvanceFromPhase: 'review',
    pendingPrompt: 'stale event prompt',
    escalationMessage: 'needs context',
    ...overrides,
  }
}

function buildDispatcher(initial: Job) {
  let stored: Job = { ...initial }
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

  return {
    dispatcher,
    getJob,
    updateJob,
    appendLog,
    getStored: () => stored,
  }
}

describe('Dispatcher.cancelJob', () => {
  it('marks the job cancelled, clears wake-up metadata, and drops queued events', async () => {
    const job = makeJob()
    const { dispatcher, updateJob, appendLog, getStored } = buildDispatcher(job)

    ;(dispatcher as unknown as { eventQueue: Map<string, unknown[]> }).eventQueue.set(job.id, [{ eventKey: 'x' }])

    const updated = await dispatcher.cancelJob(job.id, 'developer request')

    expect(updateJob).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        status: STATUS_CANCELLED,
        awaitingEvent: undefined,
        awaitingPrId: undefined,
        awaitingNextPhase: undefined,
        approvedAdvanceFromPhase: undefined,
        pendingPrompt: undefined,
        escalationMessage: undefined,
      }),
    )
    expect(updated.status).toBe(STATUS_CANCELLED)
    expect(getStored().status).toBe(STATUS_CANCELLED)
    expect(appendLog).toHaveBeenCalledWith(job.id, '[control] Job cancelled: developer request')
    expect((dispatcher as unknown as { eventQueue: Map<string, unknown[]> }).eventQueue.has(job.id)).toBe(false)
  })

  it('adds a safe-boundary note when cancelling an actively running job', async () => {
    const job = makeJob({ status: 'coding', phase: 'coding' })
    const { dispatcher, appendLog } = buildDispatcher(job)

    ;(dispatcher as unknown as { activeJobs: Set<string> }).activeJobs.add(job.id)

    await dispatcher.cancelJob(job.id)

    expect(appendLog).toHaveBeenCalledWith(
      job.id,
      expect.stringContaining('current agent turn will stop at the next safe boundary'),
    )
  })

  it('is idempotent for an already-cancelled job', async () => {
    const job = makeJob({ status: STATUS_CANCELLED })
    const { dispatcher, updateJob, appendLog } = buildDispatcher(job)

    const result = await dispatcher.cancelJob(job.id)

    expect(result).toEqual(job)
    expect(updateJob).not.toHaveBeenCalled()
    expect(appendLog).not.toHaveBeenCalled()
  })

  it('rejects cancelling a completed job', async () => {
    const job = makeJob({ status: STATUS_COMPLETE })
    const { dispatcher, updateJob } = buildDispatcher(job)

    await expect(dispatcher.cancelJob(job.id)).rejects.toThrow(/already complete/i)
    expect(updateJob).not.toHaveBeenCalled()
  })

  it('rejects manual resume and developer messages after cancellation', async () => {
    const job = makeJob({ status: STATUS_CANCELLED })
    const { dispatcher, updateJob } = buildDispatcher(job)

    await expect(dispatcher.resumeJob(job.id)).rejects.toThrow(/already cancelled/i)
    await expect(dispatcher.sendMessage(job.id, 'still there?')).rejects.toThrow(/cancelled job/i)
    expect(updateJob).not.toHaveBeenCalled()
  })

  it('rejects parked developer-input messages after cancellation even without a live query', async () => {
    const job = makeJob({
      status: STATUS_CANCELLED,
      awaitingEvent: 'developer-input: approval after review',
      phase: 'review',
    })
    const { dispatcher } = buildDispatcher(job)

    await expect(dispatcher.sendMessage(job.id, 'continue')).rejects.toThrow(/cancelled job/i)
  })
})