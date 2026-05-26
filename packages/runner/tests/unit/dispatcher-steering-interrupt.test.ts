import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Dispatcher } from '../../src/jobs/dispatcher'
import { JobType, STATUS_CODING, type Job } from '@coro-ai/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'
import type { DeveloperInputChannel, ExecutorSessionController } from '@coro-ai/plugin-sdk'

vi.mock('../../src/jobs/runner', () => ({
  runJob: vi.fn().mockResolvedValue(undefined),
}))

function makeRunningJob(): Job {
  return {
    id: 'job-steer',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { repoSlug: 'svc', serviceName: 'svc' },
    triggerSource: 'cli',
    status: STATUS_CODING,
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
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

describe('Dispatcher.sendMessage steering interrupt', () => {
  let inputQueue: DeveloperInputChannel
  let controller: ExecutorSessionController & { interrupt: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    inputQueue = { push: vi.fn(), close: vi.fn() }
    controller = {
      interrupt: vi.fn().mockResolvedValue(undefined),
      getSteeringState: vi.fn(),
    }
  })

  function makeDispatcher(job: Job) {
    return new Dispatcher({
      stateBackend: {
        getJob: vi.fn(async () => job),
        updateJob: vi.fn(async (_id, patch) => ({ ...job, ...patch })),
        appendLog: vi.fn(async () => undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as never)
  }

  it('uses safe interrupt when an MCP tool is in flight', async () => {
    const job = makeRunningJob()
    const dispatcher = makeDispatcher(job)
    ;(dispatcher as unknown as { activeInputQueues: Map<string, DeveloperInputChannel> })
      .activeInputQueues.set(job.id, inputQueue)
    ;(dispatcher as unknown as { activeSessions: Map<string, ExecutorSessionController> })
      .activeSessions.set(job.id, controller)
    ;(controller.getSteeringState as ReturnType<typeof vi.fn>).mockReturnValue({
      inFlightMcpTool: 'mcp__coro__set_job_params',
    })

    await dispatcher.sendMessage(job.id, 'use postgres not sqlite')

    expect(controller.interrupt).toHaveBeenCalledWith({ mode: 'safe' })
    expect(inputQueue.push).toHaveBeenCalled()
  })

  it('uses urgent interrupt when no MCP tool is in flight', async () => {
    const job = makeRunningJob()
    const dispatcher = makeDispatcher(job)
    ;(dispatcher as unknown as { activeInputQueues: Map<string, DeveloperInputChannel> })
      .activeInputQueues.set(job.id, inputQueue)
    ;(dispatcher as unknown as { activeSessions: Map<string, ExecutorSessionController> })
      .activeSessions.set(job.id, controller)
    ;(controller.getSteeringState as ReturnType<typeof vi.fn>).mockReturnValue({
      inFlightMcpTool: null,
    })

    await dispatcher.sendMessage(job.id, 'skip tests for now')

    expect(controller.interrupt).toHaveBeenCalledWith({ mode: 'urgent' })
  })
})
