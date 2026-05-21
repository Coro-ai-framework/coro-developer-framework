// ── dispatcher-event-queue.test.ts ───────────────────────────────────────────
//
// Batched webhook drain: multiple PR events collapse into one pendingPrompt.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Dispatcher } from '../../src/jobs/dispatcher'
import {
  buildBatchedWebhookMessage,
  buildWebhookMessage,
} from '../../src/jobs/dispatcher'
import {
  JobType,
  STATUS_AWAITING_PR_MERGE,
  STATUS_CODING,
  type Job,
} from '@coro/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'

vi.mock('../../src/jobs/runner', () => ({
  runJob: vi.fn().mockResolvedValue(undefined),
}))

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-queue-1',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { repoSlug: 'svc' },
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
    awaitingPrId: 1,
    ...overrides,
  }
}

describe('buildBatchedWebhookMessage', () => {
  it('formats a single event as 1 of 1', () => {
    const prompt = buildBatchedWebhookMessage([{
      eventKey: 'pullrequest:comment_created',
      receivedAt: '2026-05-21T01:04:12Z',
      payload: {
        pullrequest: { id: 1, title: 'Add rate limiting' },
        comment: { content: { raw: 'please fix' }, user: { display_name: 'Alice' } },
      },
    }])

    expect(prompt).toContain('[WEBHOOK EVENT: 1 received since you parked]')
    expect(prompt).toContain('Event 1 of 1 — pullrequest:comment_created')
    expect(prompt).toContain('PR #1: Add rate limiting')
    expect(prompt).toContain('Comment by Alice:')
    expect(prompt).toContain('please fix')
    expect(prompt).toContain('Decide which to act on first')
  })

  it('lists multiple events in chronological order', () => {
    const prompt = buildBatchedWebhookMessage([
      {
        eventKey: 'pullrequest:comment_created',
        receivedAt: '2026-05-21T01:04:12Z',
        payload: {
          pullrequest: { id: 1, title: 'WI-1a' },
          comment: { content: { raw: 'rename limiter' }, user: { display_name: 'Alice' } },
        },
      },
      {
        eventKey: 'pullrequest:approved',
        receivedAt: '2026-05-21T01:05:30Z',
        payload: {
          pullrequest: { id: 3, title: 'WI-2 tests', state: 'open' },
          approvalCount: 2,
        },
      },
      {
        eventKey: 'pullrequest:approved',
        receivedAt: '2026-05-21T01:06:01Z',
        payload: {
          pullrequest: { id: 2, title: 'WI-1b', state: 'open' },
          approvalCount: 1,
        },
      },
    ])

    expect(prompt).toContain('[WEBHOOK EVENTS: 3 received since you parked]')
    expect(prompt).toContain('Event 1 of 3 — pullrequest:comment_created')
    expect(prompt).toContain('Event 2 of 3 — pullrequest:approved')
    expect(prompt).toContain('Event 3 of 3 — pullrequest:approved')
    expect(prompt).toContain('PR #1: WI-1a')
    expect(prompt).toContain('PR #3: WI-2 tests')
    expect(prompt).toContain('PR #2: WI-1b')
    expect(prompt.indexOf('Event 1 of 3')).toBeLessThan(prompt.indexOf('Event 2 of 3'))
    expect(prompt.indexOf('Event 2 of 3')).toBeLessThan(prompt.indexOf('Event 3 of 3'))
  })

  it('buildWebhookMessage delegates to the batched formatter', () => {
    const single = buildWebhookMessage('pullrequest:fulfilled', {
      pullrequest: { id: 99, title: 'Done', state: 'MERGED' },
    })
    expect(single).toContain('[WEBHOOK EVENT: 1 received since you parked]')
    expect(single).toContain('PR #99: Done')
  })
})

describe('Dispatcher.injectAndResume (batched)', () => {
  let stored: Job
  const updateJob = vi.fn(async (_id: string, patch: Partial<Job>) => {
    stored = { ...stored, ...patch }
    return stored
  })
  const appendLog = vi.fn()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

  beforeEach(() => {
    stored = makeJob()
    updateJob.mockClear()
    appendLog.mockClear()
  })

  it('writes one pendingPrompt containing all events in the batch', async () => {
    const dispatcher = new Dispatcher({
      stateBackend: {
        getJob: vi.fn(async () => stored),
        updateJob,
        appendLog,
        getJobByPr: vi.fn(async () => stored),
      },
      logger,
    } as never)

    const inject = (
      dispatcher as unknown as {
        injectAndResume: (
          id: string,
          events: Array<{ eventKey: string; payload: Record<string, unknown>; receivedAt: string }>,
        ) => Promise<void>
      }
    ).injectAndResume.bind(dispatcher)

    await inject('job-queue-1', [
      { eventKey: 'pullrequest:approved', payload: { pullrequest: { id: 3 } }, receivedAt: 't1' },
      { eventKey: 'pullrequest:approved', payload: { pullrequest: { id: 2 } }, receivedAt: 't2' },
    ])

    expect(updateJob).toHaveBeenCalledWith(
      'job-queue-1',
      expect.objectContaining({
        status: STATUS_CODING,
        pendingPrompt: expect.stringContaining('[WEBHOOK EVENTS: 2 received since you parked]'),
      }),
    )
    expect(appendLog).toHaveBeenCalledWith(
      'job-queue-1',
      '[webhook] Received 2 events: pullrequest:approved, pullrequest:approved',
    )
  })
})
