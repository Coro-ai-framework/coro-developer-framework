import { describe, expect, it, vi } from 'vitest'
import { Dispatcher } from '../../src/jobs/dispatcher'
import {
  JobType,
  STATUS_CODING,
  STATUS_ESCALATED,
  emptyTokenUsage,
  type Job,
} from '../../src/jobs/types'

vi.mock('../../src/jobs/runner', () => ({
  runJob: vi.fn().mockResolvedValue(undefined),
}))

function makeJob(): Job {
  return {
    id: 'job-escalated-message',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { repoSlug: 'svc', serviceName: 'svc' },
    triggerSource: 'cli',
    status: STATUS_ESCALATED,
    phase: 'planning',
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
    escalationMessage: 'Need a decision on the EF Core provider version before continuing.',
  }
}

describe('Dispatcher.sendMessage (escalated jobs)', () => {
  it('resumes an escalated job with the escalation reason and developer reply in the pending prompt', async () => {
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

    const developerReply = 'Use the EF Core 7 line and continue with the fallback path.'
    await dispatcher.sendMessage(job.id, developerReply)

    expect(updateJob).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        status: STATUS_CODING,
        escalationMessage: undefined,
        awaitingEvent: undefined,
        awaitingPrId: undefined,
        awaitingNextPhase: undefined,
        pendingPrompt: expect.stringContaining(job.escalationMessage as string),
      }),
    )
    expect(updateJob).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        pendingPrompt: expect.stringContaining(developerReply),
      }),
    )
    expect(appendLog).toHaveBeenCalledWith(job.id, `[human] ${developerReply}`)
  })
})