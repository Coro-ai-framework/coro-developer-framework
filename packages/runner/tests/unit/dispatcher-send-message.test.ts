import { describe, it, expect, vi } from 'vitest'
import { Dispatcher } from '../../src/jobs/dispatcher'
import {
  JobType,
  STATUS_AWAITING_DEVELOPER_INPUT,
  STATUS_CODING,
  type Job,
} from '@coro-ai/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'

vi.mock('../../src/jobs/runner', () => ({
  runJob: vi.fn().mockResolvedValue(undefined),
}))

function makeJob(): Job {
  return {
    id: 'job-dev-input',
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
    interactive: true,
    artifacts: [],
    insights: [],
    tokenUsage: emptyTokenUsage(),
    phaseUsage: [],
    sessionId: 'sess-old-123',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    awaitingEvent: 'developer-input: approval after coding',
    awaitingNextPhase: 'review',
  }
}

describe('Dispatcher.sendMessage', () => {
  it('resumes a parked developer-input job and stamps the approved advance', async () => {
    const job = makeJob()
    const getJob = vi.fn(async () => job)
    const updateJob = vi.fn(async (_jobId: string, patch: Partial<Job>) => ({ ...job, ...patch }))
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

    await dispatcher.sendMessage(job.id, 'go ahead')

    expect(updateJob).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        status: STATUS_CODING,
        awaitingEvent: undefined,
        awaitingPrId: undefined,
        awaitingNextPhase: undefined,
        approvedAdvanceFromPhase: 'coding',
        escalationMessage: undefined,
        pendingPrompt: expect.stringContaining('[DEVELOPER RESPONSE]'),
        checkpointApproval: expect.objectContaining({
          fromPhase: 'coding',
          forPhase: 'review',
          message: 'go ahead',
        }),
      }),
    )
  })

  it('does not carry an approval for a mid-phase question', async () => {
    // No `awaitingNextPhase` — the agent asked something inside the phase, so
    // the answer belongs to that phase alone and must not resurface later.
    const job = { ...makeJob(), awaitingNextPhase: undefined }
    const getJob = vi.fn(async () => job)
    const updateJob = vi.fn(async (_jobId: string, patch: Partial<Job>) => ({ ...job, ...patch }))

    const dispatcher = new Dispatcher({
      stateBackend: { getJob, updateJob, appendLog: vi.fn(async () => undefined) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as never)

    await dispatcher.sendMessage(job.id, 'yes, make it idempotent')

    const patch = updateJob.mock.calls[0]?.[1] as Partial<Job>
    expect(patch.checkpointApproval).toBeUndefined()
    expect(patch.approvedAdvanceFromPhase).toBeUndefined()
  })

  it('preserves earlier pendingPrompt when another parked message arrives', async () => {
    const job = { ...makeJob(), pendingPrompt: '[DEVELOPER RESPONSE]\nfirst message' }
    const getJob = vi.fn(async () => job)
    const updateJob = vi.fn(async (_jobId: string, patch: Partial<Job>) => ({ ...job, ...patch }))
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

    await dispatcher.sendMessage(job.id, 'second message')

    expect(updateJob).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining('first message'),
      }),
    )
    const patch = updateJob.mock.calls[0]?.[1] as Partial<Job>
    expect(typeof patch.pendingPrompt).toBe('string')
    expect(patch.pendingPrompt).toContain('first message')
    expect(patch.pendingPrompt).toContain('second message')
    expect(patch.pendingPrompt).toContain('---')
  })
})
