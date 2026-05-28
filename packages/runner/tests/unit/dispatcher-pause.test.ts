import { describe, it, expect, vi } from 'vitest'
import { Dispatcher } from '../../src/jobs/dispatcher'
import {
  JobType,
  STATUS_AWAITING_DEVELOPER_INPUT,
  STATUS_CODING,
  type Job,
} from '@coro-ai/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'
import type { DeveloperInputChannel, ExecutorSessionController } from '@coro-ai/plugin-sdk'

vi.mock('../../src/jobs/runner', () => ({
  runJob: vi.fn().mockResolvedValue(undefined),
}))

function makeRunningJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-pause',
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
    ...overrides,
  }
}

describe('Dispatcher.pauseJob', () => {
  it('uses safe interrupt when MCP tool is in flight and keeps input queue open', async () => {
    const job = makeRunningJob()
    const stored = { ...job }
    const updateJob = vi.fn(async (_jobId: string, patch: Partial<Job>) => ({ ...stored, ...patch }))
    const dispatcher = new Dispatcher({
      stateBackend: {
        getJob: vi.fn(async () => stored),
        updateJob,
        appendLog: vi.fn(async () => undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as never)

    const inputQueue: DeveloperInputChannel = { push: vi.fn(), close: vi.fn() }
    const controller: ExecutorSessionController = {
      interrupt: vi.fn().mockResolvedValue(undefined),
      getSteeringState: vi.fn(() => ({ inFlightMcpTool: 'mcp__coro__scm_clone_repo' })),
    }

    ;(dispatcher as unknown as { activeJobs: Set<string> }).activeJobs.add(job.id)
    ;(dispatcher as unknown as { activeInputQueues: Map<string, DeveloperInputChannel> })
      .activeInputQueues.set(job.id, inputQueue)
    ;(dispatcher as unknown as { activeSessions: Map<string, ExecutorSessionController> })
      .activeSessions.set(job.id, controller)

    const result = await dispatcher.pauseJob(job.id)
    await Promise.resolve()

    expect(result.status).toBe(STATUS_AWAITING_DEVELOPER_INPUT)
    expect(controller.interrupt).toHaveBeenCalledWith({ mode: 'safe' })
    expect(inputQueue.close).not.toHaveBeenCalled()
  })

  it('does not clear existing pendingPrompt while pausing', async () => {
    const job = makeRunningJob({ pendingPrompt: '[DEVELOPER RESPONSE]\nkeep me' })
    let stored = { ...job }
    const dispatcher = new Dispatcher({
      stateBackend: {
        getJob: vi.fn(async () => stored),
        updateJob: vi.fn(async (_jobId: string, patch: Partial<Job>) => {
          stored = { ...stored, ...patch }
          return stored
        }),
        appendLog: vi.fn(async () => undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as never)

    const result = await dispatcher.pauseJob(job.id)
    expect(result.pendingPrompt).toContain('keep me')
  })
})
