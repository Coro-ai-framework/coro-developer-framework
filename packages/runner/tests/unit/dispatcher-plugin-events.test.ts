// ── Plugin webhook events (P4) ────────────────────────────────────────────────
//
// Covers the post-P4 generic plugin path on Dispatcher.handleInboundEvent.
// Events arrive with `source: 'plugin'`, a `pluginId`, and an
// {@link ExternalRef}; the dispatcher resolves the parked job through
// {@link resolveJobByExternalRef} (which falls back to legacy
// `getJobByPr` / `getJobByJiraTicket` until P5) and resumes it.

import { describe, it, expect, vi } from 'vitest'
import { Dispatcher, eventIndicatesMerge } from '../../src/jobs/dispatcher'
import type { InboundEvent } from '@coro-ai/cloud-protocol'
import type { EventTransport } from '../../src/state/transport'
import type { ExternalRef } from '@coro-ai/cloud-protocol'
import {
  JobType,
  STATUS_AWAITING_PR_MERGE,
  STATUS_AWAITING_DEVELOPER_INPUT,
  STATUS_CANCELLED,
  STATUS_CODING,
  type Job,
} from '@coro-ai/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'

vi.mock('../../src/jobs/runner', () => ({
  runJob: vi.fn().mockResolvedValue(undefined),
}))

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-plugin-1',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { repoSlug: 'svc' },
    triggerSource: 'cli',
    status: STATUS_AWAITING_PR_MERGE,
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
    awaitingPrId: 42,
    ...overrides,
  }
}

interface BuildOptions {
  job: Job
  /** Override the lookup the dispatcher does to find a job by ref. */
  getJobByPr?: ReturnType<typeof vi.fn>
  getJobByJiraTicket?: ReturnType<typeof vi.fn>
}

function buildDispatcher(opts: BuildOptions) {
  let stored = opts.job
  const getJob = vi.fn(async () => stored)
  const updateJob = vi.fn(async (_id: string, patch: Partial<Job>) => {
    stored = { ...stored, ...patch }
    return stored
  })
  const appendLog = vi.fn(async () => undefined)
  const markPrMerged = vi.fn(async (_id: string, prId: number, mergedAt: string) => {
    stored = {
      ...stored,
      prMappings: stored.prMappings.map(pm =>
        pm.prId === prId ? { ...pm, mergedAt } : pm,
      ),
    }
    return stored
  })

  const getJobByPr = opts.getJobByPr ?? vi.fn(async () => stored)
  const getJobByJiraTicket = opts.getJobByJiraTicket ?? vi.fn(async () => stored)

  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }

  let onEventHandler: ((e: InboundEvent) => Promise<void>) | undefined
  const transport: EventTransport = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    isConnected: vi.fn(() => true),
    onEvent: vi.fn((h: (e: InboundEvent) => Promise<void>) => {
      onEventHandler = h
    }),
    emit: vi.fn(async () => undefined),
  }

  const dispatcher = new Dispatcher(
    {
      stateBackend: {
        getJob, updateJob, appendLog, markPrMerged, getJobByPr, getJobByJiraTicket,
      },
      logger,
    } as never,
    transport,
  )

  const deliver = async (event: InboundEvent): Promise<void> => {
    if (!onEventHandler) throw new Error('Transport handler not registered')
    await onEventHandler(event)
  }

  return {
    dispatcher,
    deliver,
    updateJob,
    appendLog,
    markPrMerged,
    getJobByPr,
    getJobByJiraTicket,
    logger,
  }
}

function prRef(externalId: string, pluginId = 'github', repoKey = 'svc'): ExternalRef {
  return { kind: 'pull_request', pluginId, repoKey, externalId }
}

function ticketRef(externalId: string, pluginId = 'jira'): ExternalRef {
  return { kind: 'ticket', pluginId, externalId }
}

describe('Dispatcher plugin webhook events (P4)', () => {
  it('routes a pull_request ref through getJobByPr and resumes the parked job', async () => {
    const job = makeJob()
    const { deliver, updateJob, appendLog, getJobByPr } = buildDispatcher({ job })

    await deliver({
      source: 'plugin',
      pluginId: 'github',
      ref: prRef('42'),
      eventKey: 'pr.merged',
      payload: { pullrequest: { id: 42 } },
      receivedAt: new Date().toISOString(),
    })

    expect(getJobByPr).toHaveBeenCalledWith(42)
    expect(updateJob).toHaveBeenCalledWith(
      job.id,
      expect.objectContaining({
        status: STATUS_CODING,
        awaitingEvent: undefined,
        awaitingPrId: undefined,
      }),
    )
    expect(appendLog).toHaveBeenCalledWith(job.id, expect.stringContaining('Received: pr.merged'))
  })

  it('routes a ticket ref through getJobByJiraTicket', async () => {
    const job = makeJob({ status: STATUS_AWAITING_DEVELOPER_INPUT })
    const { deliver, getJobByJiraTicket, updateJob } = buildDispatcher({ job })

    await deliver({
      source: 'plugin',
      pluginId: 'jira',
      ref: ticketRef('PROJ-1'),
      eventKey: 'ticket.commented',
      payload: { issue: { key: 'PROJ-1' } },
      receivedAt: new Date().toISOString(),
    })

    expect(getJobByJiraTicket).toHaveBeenCalledWith('PROJ-1')
    expect(updateJob).toHaveBeenCalled()
  })

  it('skips silently when no job exists for the ref', async () => {
    const job = makeJob()
    const { deliver, updateJob, logger } = buildDispatcher({
      job,
      getJobByPr: vi.fn(async () => null),
    })

    await deliver({
      source: 'plugin',
      pluginId: 'github',
      ref: prRef('999'),
      eventKey: 'pr.commented',
      payload: {},
      receivedAt: new Date().toISOString(),
    })

    expect(updateJob).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ ref: expect.objectContaining({ externalId: '999' }) }),
      expect.stringContaining('No job found'),
    )
  })

  it('skips when the event has no ref attached', async () => {
    const job = makeJob()
    const { deliver, updateJob, getJobByPr, logger } = buildDispatcher({ job })

    await deliver({
      source: 'plugin',
      pluginId: 'github',
      eventKey: 'pr.something',
      payload: {},
      receivedAt: new Date().toISOString(),
    })

    expect(getJobByPr).not.toHaveBeenCalled()
    expect(updateJob).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: 'github' }),
      expect.stringContaining('no ExternalRef'),
    )
  })

  it('skips when the matched job is not in a parking status', async () => {
    const job = makeJob({ status: STATUS_CODING })
    const { deliver, updateJob, logger } = buildDispatcher({ job })

    await deliver({
      source: 'plugin',
      pluginId: 'github',
      ref: prRef('42'),
      eventKey: 'pr.commented',
      payload: {},
      receivedAt: new Date().toISOString(),
    })

    expect(updateJob).not.toHaveBeenCalled()
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id, status: STATUS_CODING }),
      expect.stringContaining('not parked'),
    )
  })

  it('does not queue webhook events for a cancelled job, even if the runner is still active', async () => {
    const job = makeJob({ status: STATUS_CANCELLED })
    const { dispatcher, deliver, updateJob, logger } = buildDispatcher({ job })

    ;(dispatcher as unknown as { activeJobs: Set<string> }).activeJobs.add(job.id)

    await deliver({
      source: 'plugin',
      pluginId: 'github',
      ref: prRef('42'),
      eventKey: 'pr.commented',
      payload: {},
      receivedAt: new Date().toISOString(),
    })

    expect(updateJob).not.toHaveBeenCalled()
    expect((dispatcher as unknown as { eventQueue: Map<string, unknown[]> }).eventQueue.has(job.id)).toBe(false)
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id, status: STATUS_CANCELLED }),
      expect.stringContaining('terminal'),
    )
  })

  it('uses backend.getJobByExternalRef when implemented (P5 forward-compat)', async () => {
    const job = makeJob()
    const getJobByExternalRef = vi.fn(async () => job)

    const updateJob = vi.fn(async (_id: string, patch: Partial<Job>) => ({ ...job, ...patch }))
    const appendLog = vi.fn(async () => undefined)
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

    let onEventHandler: ((e: InboundEvent) => Promise<void>) | undefined
    const transport: EventTransport = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      isConnected: vi.fn(() => true),
      onEvent: vi.fn((h) => { onEventHandler = h }),
      emit: vi.fn(async () => undefined),
    }

    new Dispatcher(
      {
        stateBackend: {
          getJob: vi.fn(async () => job),
          updateJob,
          appendLog,
          getJobByExternalRef,
        },
        logger,
      } as never,
      transport,
    )

    const ref = prRef('42', 'github', 'svc')
    await onEventHandler!({
      source: 'plugin',
      pluginId: 'github',
      ref,
      eventKey: 'pr.merged',
      payload: {},
      receivedAt: new Date().toISOString(),
    })

    expect(getJobByExternalRef).toHaveBeenCalledWith(ref)
    expect(updateJob).toHaveBeenCalled()
  })

  it('falls back to legacy getJobByPr when getJobByExternalRef returns null', async () => {
    const job = makeJob()
    const getJobByExternalRef = vi.fn(async () => null)
    const getJobByPr = vi.fn(async () => job)

    const updateJob = vi.fn(async (_id: string, patch: Partial<Job>) => ({ ...job, ...patch }))
    const appendLog = vi.fn(async () => undefined)
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

    let onEventHandler: ((e: InboundEvent) => Promise<void>) | undefined
    const transport: EventTransport = {
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      isConnected: vi.fn(() => true),
      onEvent: vi.fn((h) => { onEventHandler = h }),
      emit: vi.fn(async () => undefined),
    }

    new Dispatcher(
      {
        stateBackend: {
          getJob: vi.fn(async () => job),
          updateJob,
          appendLog,
          getJobByExternalRef,
          getJobByPr,
        },
        logger,
      } as never,
      transport,
    )

    await onEventHandler!({
      source: 'plugin',
      pluginId: 'github',
      ref: prRef('42', 'github', 'svc'),
      eventKey: 'pullrequest:fulfilled',
      payload: {},
      receivedAt: new Date().toISOString(),
    })

    expect(getJobByExternalRef).toHaveBeenCalledWith(prRef('42', 'github', 'svc'))
    expect(getJobByPr).toHaveBeenCalledWith(42)
    expect(updateJob).toHaveBeenCalled()
  })
})

describe('Dispatcher merge reconciliation (stale prMappings guard)', () => {
  function mappingJob(overrides: Partial<Job> = {}): Job {
    return makeJob({
      prMappings: [
        { prId: 25, workItem: 'initiate-service', repoSlug: 'svc', openedAt: '2026-01-01T00:00:00Z' },
      ],
      ...overrides,
    })
  }

  it('stamps mergedAt when the poller reports an open mapping as fulfilled', async () => {
    // Regression: a stacked PR the SCM auto-merged when its base merged
    // never went through `scm_merge_pr`, so the mapping stayed "open" and
    // the coding-preflight looped the job. The merge event must reconcile.
    const job = mappingJob()
    const { deliver, markPrMerged } = buildDispatcher({ job })

    await deliver({
      source: 'plugin',
      pluginId: 'bitbucket',
      ref: prRef('25', 'bitbucket', 'svc'),
      eventKey: 'pullrequest:fulfilled',
      payload: { state: 'MERGED', prId: 25, pullrequest: { id: 25, state: 'MERGED' } },
      receivedAt: new Date().toISOString(),
    })

    expect(markPrMerged).toHaveBeenCalledWith(job.id, 25, expect.any(String))
  })

  it('stamps mergedAt for a GitHub merge webhook (closed + merged:true)', async () => {
    // GitHub normalises a merge to `pr.declined` (action=closed); only
    // the raw `pull_request.merged` flag distinguishes it from a plain close.
    const job = mappingJob({ prMappings: [
      { prId: 42, workItem: 'wi', repoSlug: 'svc', openedAt: '2026-01-01T00:00:00Z' },
    ] })
    const { deliver, markPrMerged } = buildDispatcher({ job })

    await deliver({
      source: 'plugin',
      pluginId: 'github',
      ref: prRef('42', 'github', 'svc'),
      eventKey: 'pr.declined',
      payload: { pull_request: { id: 42, state: 'closed', merged: true } },
      receivedAt: new Date().toISOString(),
    })

    expect(markPrMerged).toHaveBeenCalledWith(job.id, 42, expect.any(String))
  })

  it('does NOT stamp mergedAt for a GitHub close-without-merge', async () => {
    const job = mappingJob({ prMappings: [
      { prId: 42, workItem: 'wi', repoSlug: 'svc', openedAt: '2026-01-01T00:00:00Z' },
    ] })
    const { deliver, markPrMerged } = buildDispatcher({ job })

    await deliver({
      source: 'plugin',
      pluginId: 'github',
      ref: prRef('42', 'github', 'svc'),
      eventKey: 'pr.declined',
      payload: { pull_request: { id: 42, state: 'closed', merged: false } },
      receivedAt: new Date().toISOString(),
    })

    expect(markPrMerged).not.toHaveBeenCalled()
  })

  it('is a no-op when the mapping is already merged', async () => {
    const job = mappingJob({ prMappings: [
      { prId: 25, workItem: 'initiate-service', repoSlug: 'svc', openedAt: '2026-01-01T00:00:00Z', mergedAt: '2026-01-02T00:00:00Z' },
    ] })
    const { deliver, markPrMerged } = buildDispatcher({ job })

    await deliver({
      source: 'plugin',
      pluginId: 'bitbucket',
      ref: prRef('25', 'bitbucket', 'svc'),
      eventKey: 'pr.merged',
      payload: { state: 'MERGED' },
      receivedAt: new Date().toISOString(),
    })

    expect(markPrMerged).not.toHaveBeenCalled()
  })

  it('reconciles even while the job is actively running (event also queued)', async () => {
    const job = mappingJob({ status: STATUS_CODING })
    const { dispatcher, deliver, markPrMerged } = buildDispatcher({ job })
    ;(dispatcher as unknown as { activeJobs: Set<string> }).activeJobs.add(job.id)

    await deliver({
      source: 'plugin',
      pluginId: 'bitbucket',
      ref: prRef('25', 'bitbucket', 'svc'),
      eventKey: 'pullrequest:fulfilled',
      payload: { state: 'MERGED' },
      receivedAt: new Date().toISOString(),
    })

    // Stamped immediately, before the event is queued for the running phase.
    expect(markPrMerged).toHaveBeenCalledWith(job.id, 25, expect.any(String))
  })

  it('does not throw when markPrMerged fails — the merge already happened', async () => {
    const job = mappingJob()
    const built = buildDispatcher({ job })
    built.markPrMerged.mockRejectedValueOnce(new Error('backend down'))

    await expect(built.deliver({
      source: 'plugin',
      pluginId: 'bitbucket',
      ref: prRef('25', 'bitbucket', 'svc'),
      eventKey: 'pullrequest:fulfilled',
      payload: { state: 'MERGED' },
      receivedAt: new Date().toISOString(),
    })).resolves.toBeUndefined()

    expect(built.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id, prId: 25 }),
      expect.stringContaining('Failed to reconcile mergedAt'),
    )
  })
})

describe('eventIndicatesMerge', () => {
  it('recognises poller and normalised merge event keys', () => {
    expect(eventIndicatesMerge('pullrequest:fulfilled', {})).toBe(true)
    expect(eventIndicatesMerge('pr.merged', {})).toBe(true)
    expect(eventIndicatesMerge('PR.MERGED', {})).toBe(true)
  })

  it('recognises merged payload state shapes', () => {
    expect(eventIndicatesMerge('pr.updated', { state: 'MERGED' })).toBe(true)
    expect(eventIndicatesMerge('pr.updated', { pullrequest: { state: 'merged' } })).toBe(true)
    expect(eventIndicatesMerge('pr.declined', { pull_request: { state: 'closed', merged: true } })).toBe(true)
  })

  it('does not treat comments, approvals, or plain closes as merges', () => {
    expect(eventIndicatesMerge('pr.commented', {})).toBe(false)
    expect(eventIndicatesMerge('pr.approved', { approvalCount: 1 })).toBe(false)
    expect(eventIndicatesMerge('pr.declined', { pull_request: { state: 'closed', merged: false } })).toBe(false)
    expect(eventIndicatesMerge('pr.updated', { state: 'open' })).toBe(false)
  })
})
