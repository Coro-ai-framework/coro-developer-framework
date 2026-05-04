// ── Cloud-initiated control events ────────────────────────────────────────────
//
// Covers Dispatcher.handleWebhookEvent's `source: 'cloud'` branch — the path
// that turns control-plane WebSocket frames (event:resume, event:message)
// into resumeJob / sendMessage calls. Without these branches the cloud REST
// API (POST .../resume, POST .../message) silently no-ops on the runner.

import { describe, it, expect, vi } from 'vitest'
import { Dispatcher } from '../../src/jobs/dispatcher'
import type { InboundEvent } from '../../src/state/events'
import type { EventTransport } from '../../src/state/transport'
import {
  JobType,
  STATUS_AWAITING_DEVELOPER_INPUT,
  STATUS_AWAITING_PR_MERGE,
  STATUS_CODING,
  emptyTokenUsage,
  type Job,
} from '../../src/jobs/types'

vi.mock('../../src/jobs/runner', () => ({
  runJob: vi.fn().mockResolvedValue(undefined),
}))

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-cloud-1',
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
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    awaitingEvent: 'developer-input: approval after coding',
    awaitingNextPhase: 'review',
    ...overrides,
  }
}

/**
 * Build a dispatcher with a fake transport so we can drive InboundEvents
 * through the same code path the WebSocket transport uses in production.
 */
function buildDispatcher(initial: Job) {
  let stored: Job = { ...initial }
  const getJob = vi.fn(async () => stored)
  const updateJob = vi.fn(async (_jobId: string, patch: Partial<Job>) => {
    stored = { ...stored, ...patch }
    return stored
  })
  const appendLog = vi.fn(async () => undefined)
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }

  let onEventHandler: ((event: InboundEvent) => Promise<void>) | undefined
  const transport: EventTransport = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    isConnected: vi.fn(() => true),
    onEvent: vi.fn((h: (event: InboundEvent) => Promise<void>) => {
      onEventHandler = h
    }),
    emit: vi.fn(async () => undefined),
  }

  const dispatcher = new Dispatcher(
    {
      stateBackend: { getJob, updateJob, appendLog },
      logger,
    } as never,
    transport,
  )

  const deliver = async (event: InboundEvent): Promise<void> => {
    if (!onEventHandler) throw new Error('Transport handler not registered')
    await onEventHandler(event)
  }

  return { dispatcher, deliver, updateJob, appendLog, getStored: () => stored, logger }
}

describe('Dispatcher cloud control events', () => {
  describe('event:resume → job:resume', () => {
    it('clears parking fields, restarts the runner, and logs the resume', async () => {
      const job = makeJob()
      const { deliver, updateJob, appendLog } = buildDispatcher(job)

      await deliver({
        source: 'cloud',
        eventKey: 'job:resume',
        payload: { jobId: job.id },
        receivedAt: new Date().toISOString(),
      })

      expect(updateJob).toHaveBeenCalledWith(
        job.id,
        expect.objectContaining({
          status: STATUS_CODING,
          awaitingEvent: undefined,
          awaitingPrId: undefined,
        }),
      )
      expect(appendLog).toHaveBeenCalledWith(
        job.id,
        expect.stringContaining('Continuing phase: coding'),
      )
    })

    it('moves to a different phase when prompt carries a phase override', async () => {
      const job = makeJob({ status: STATUS_AWAITING_PR_MERGE })
      const { deliver, updateJob } = buildDispatcher(job)

      await deliver({
        source: 'cloud',
        eventKey: 'job:resume',
        payload: { jobId: job.id, prompt: 'planning' },
        receivedAt: new Date().toISOString(),
      })

      expect(updateJob).toHaveBeenCalledWith(
        job.id,
        expect.objectContaining({
          status: STATUS_CODING,
          phase: 'planning',
          sessionId: undefined,
        }),
      )
    })

    it('skips silently when payload is missing jobId', async () => {
      const job = makeJob()
      const { deliver, updateJob, logger } = buildDispatcher(job)

      await deliver({
        source: 'cloud',
        eventKey: 'job:resume',
        payload: {},
        receivedAt: new Date().toISOString(),
      })

      expect(updateJob).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ eventKey: 'job:resume' }),
        expect.stringContaining('missing jobId'),
      )
    })

    it('does not crash the transport when resumeJob throws', async () => {
      const job = makeJob({ status: 'complete' })
      const { deliver, logger } = buildDispatcher(job)

      // resumeJob throws on already-complete jobs — must be caught so the
      // transport keeps delivering subsequent events.
      await expect(deliver({
        source: 'cloud',
        eventKey: 'job:resume',
        payload: { jobId: job.id },
        receivedAt: new Date().toISOString(),
      })).resolves.toBeUndefined()

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: job.id }),
        expect.stringContaining('Cloud resume failed'),
      )
    })
  })

  describe('event:message → job:message', () => {
    it('injects the message via the parked-developer-input path', async () => {
      const job = makeJob() // already STATUS_AWAITING_DEVELOPER_INPUT
      const { deliver, updateJob, appendLog } = buildDispatcher(job)

      await deliver({
        source: 'cloud',
        eventKey: 'job:message',
        payload: { jobId: job.id, message: 'go ahead' },
        receivedAt: new Date().toISOString(),
      })

      expect(updateJob).toHaveBeenCalledWith(
        job.id,
        expect.objectContaining({
          status: STATUS_CODING,
          pendingPrompt: expect.stringContaining('[DEVELOPER RESPONSE]'),
        }),
      )
      expect(appendLog).toHaveBeenCalledWith(job.id, expect.stringContaining('[human] go ahead'))
    })

    it('skips silently when payload is missing the message text', async () => {
      const job = makeJob()
      const { deliver, updateJob, logger } = buildDispatcher(job)

      await deliver({
        source: 'cloud',
        eventKey: 'job:message',
        payload: { jobId: job.id },
        receivedAt: new Date().toISOString(),
      })

      expect(updateJob).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: job.id }),
        expect.stringContaining('missing message text'),
      )
    })

    it('does not crash the transport when sendMessage throws', async () => {
      const job = makeJob({ status: 'complete' })
      const { deliver, logger } = buildDispatcher(job)

      await expect(deliver({
        source: 'cloud',
        eventKey: 'job:message',
        payload: { jobId: job.id, message: 'hi' },
        receivedAt: new Date().toISOString(),
      })).resolves.toBeUndefined()

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: job.id }),
        expect.stringContaining('Cloud message injection failed'),
      )
    })
  })

  describe('unknown / out-of-place cloud events', () => {
    it('logs and ignores unknown cloud event keys', async () => {
      const job = makeJob()
      const { deliver, updateJob, logger } = buildDispatcher(job)

      await deliver({
        source: 'cloud',
        eventKey: 'job:something-new',
        payload: { jobId: job.id },
        receivedAt: new Date().toISOString(),
      })

      expect(updateJob).not.toHaveBeenCalled()
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ eventKey: 'job:something-new', jobId: job.id }),
        expect.stringContaining('Unknown cloud event key'),
      )
    })

    it('warns when job:dispatch reaches the base dispatcher (hybrid wiring missing)', async () => {
      const job = makeJob()
      const { deliver, updateJob, logger } = buildDispatcher(job)

      // wireCloudJobDispatch normally intercepts this before it reaches the
      // base handler; if it ever falls through, we want loud diagnostics.
      await deliver({
        source: 'cloud',
        eventKey: 'job:dispatch',
        payload: { jobId: job.id },
        receivedAt: new Date().toISOString(),
      })

      expect(updateJob).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ eventKey: 'job:dispatch', jobId: job.id }),
        expect.stringContaining('hybrid wiring may be missing'),
      )
    })
  })
})
