import { describe, it, expect, afterEach, vi } from 'vitest'
import { PollingTransport, type PrPoller } from '../../src/state/polling-transport'
import type { StateBackend } from '../../src/state/backend'
import type { InboundEvent } from '../../src/state/events'
import { Job, JobType, emptyTokenUsage } from '../../src/jobs/types'
import pino from 'pino'

// ── Mock factories ──────────────────────────────────────────────────────────

const logger = pino({ level: 'silent' })

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'test-job-1',
    type: JobType.Feature,
    workflowPath: 'workflows/feature/workflow.md',
    params: { serviceName: 'svc', repoSlug: 'my-repo' },
    triggerSource: 'cli',
    status: 'awaiting-pr-merge',
    phase: 'coding',
    currentFeature: null,
    features: [],
    featureLoopCount: 0,
    prMappings: [{ prId: 42, feature: 'feat/x', repoSlug: 'my-repo', openedAt: '2026-01-01T00:00:00Z' }],
    insights: [],
    tokenUsage: emptyTokenUsage(),
    phaseUsage: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    awaitingPrId: 42,
    ...overrides,
  }
}

function makeMockBackend(jobs: Job[]): StateBackend {
  return {
    listJobs: vi.fn().mockResolvedValue(jobs),
    // Stubs for the rest — not exercised in these tests
    createJob: vi.fn(),
    getJob: vi.fn(),
    updateJob: vi.fn(),
    listJobsByType: vi.fn(),
    deleteJob: vi.fn(),
    appendLog: vi.fn(),
    getLog: vi.fn(),
    logLength: vi.fn(),
    mapPrToJob: vi.fn(),
    getJobByPr: vi.fn(),
    addPrMapping: vi.fn(),
    markPrMerged: vi.fn(),
    mapJiraTicketToJob: vi.fn(),
    getJobByJiraTicket: vi.fn(),
    mapRepoToJob: vi.fn(),
    createProposal: vi.fn(),
    listProposals: vi.fn(),
    getProposal: vi.fn(),
    updateProposal: vi.fn(),
  }
}

function makeMockPoller(state = 'OPEN', approvalCount = 0, comments: Array<{ id: number; content: { raw: string }; created_on: string }> = []): PrPoller {
  return {
    getPrStatus: vi.fn().mockResolvedValue({ state, approvalCount }),
    getComments: vi.fn().mockResolvedValue(comments),
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PollingTransport', () => {
  let transport: PollingTransport

  afterEach(async () => {
    if (transport) await transport.disconnect()
  })

  describe('lifecycle', () => {
    it('starts disconnected', () => {
      const backend = makeMockBackend([])
      const poller = makeMockPoller()
      transport = new PollingTransport({
        stateBackend: backend,
        prPoller: poller,
        logger,
        intervalMs: 60_000,
      })
      expect(transport.isConnected()).toBe(false)
    })

    it('connects and disconnects', async () => {
      const backend = makeMockBackend([])
      const poller = makeMockPoller()
      transport = new PollingTransport({
        stateBackend: backend,
        prPoller: poller,
        logger,
        intervalMs: 60_000,
      })

      await transport.connect()
      expect(transport.isConnected()).toBe(true)

      await transport.disconnect()
      expect(transport.isConnected()).toBe(false)
    })
  })

  describe('emit', () => {
    it('is a no-op (does not throw)', async () => {
      const backend = makeMockBackend([])
      const poller = makeMockPoller()
      transport = new PollingTransport({
        stateBackend: backend,
        prPoller: poller,
        logger,
      })

      await expect(transport.emit({
        type: 'job:log',
        jobId: 'j1',
        data: { line: 'test' },
      })).resolves.toBeUndefined()
    })
  })

  describe('poll', () => {
    it('skips poll when no parked jobs exist', async () => {
      const backend = makeMockBackend([])
      const poller = makeMockPoller()
      transport = new PollingTransport({
        stateBackend: backend,
        prPoller: poller,
        logger,
      })

      await transport.poll()
      expect(poller.getPrStatus).not.toHaveBeenCalled()
    })

    it('skips jobs without awaitingPrId', async () => {
      const job = makeJob({ awaitingPrId: undefined })
      const backend = makeMockBackend([job])
      const poller = makeMockPoller()
      transport = new PollingTransport({
        stateBackend: backend,
        prPoller: poller,
        logger,
      })

      await transport.poll()
      expect(poller.getPrStatus).not.toHaveBeenCalled()
    })

    it('caches initial snapshot without delivering events', async () => {
      const job = makeJob()
      const backend = makeMockBackend([job])
      const poller = makeMockPoller('OPEN', 0, [])
      const events: InboundEvent[] = []
      transport = new PollingTransport({
        stateBackend: backend,
        prPoller: poller,
        logger,
      })
      transport.onEvent(async (e) => { events.push(e) })

      await transport.poll()

      // First poll — snapshot only, no events
      expect(events).toHaveLength(0)
      expect(poller.getPrStatus).toHaveBeenCalledWith('my-repo', 42)
    })

    it('detects PR merge and delivers event', async () => {
      const job = makeJob()
      const backend = makeMockBackend([job])
      const poller = makeMockPoller('OPEN', 0, [])
      const events: InboundEvent[] = []
      transport = new PollingTransport({
        stateBackend: backend,
        prPoller: poller,
        logger,
      })
      transport.onEvent(async (e) => { events.push(e) })

      // First poll — cache baseline
      await transport.poll()
      expect(events).toHaveLength(0)

      // Now change PR state to MERGED
      ;(poller.getPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'MERGED', approvalCount: 0 })

      // Second poll — should detect the change
      await transport.poll()
      expect(events).toHaveLength(1)
      expect(events[0].eventKey).toBe('pullrequest:fulfilled')
    })

    it('detects PR approval and delivers event', async () => {
      const job = makeJob()
      const backend = makeMockBackend([job])
      const poller = makeMockPoller('OPEN', 0, [])
      const events: InboundEvent[] = []
      transport = new PollingTransport({
        stateBackend: backend,
        prPoller: poller,
        logger,
      })
      transport.onEvent(async (e) => { events.push(e) })

      // First poll — baseline
      await transport.poll()

      // Approval added
      ;(poller.getPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'OPEN', approvalCount: 1 })

      // Second poll
      await transport.poll()
      expect(events).toHaveLength(1)
      expect(events[0].eventKey).toBe('pullrequest:approved')
    })

    it('detects new comments and delivers events', async () => {
      const job = makeJob()
      const backend = makeMockBackend([job])
      const initialComments: Array<{ id: number; content: { raw: string }; created_on: string }> = []
      const poller = makeMockPoller('OPEN', 0, initialComments)
      const events: InboundEvent[] = []
      transport = new PollingTransport({
        stateBackend: backend,
        prPoller: poller,
        logger,
      })
      transport.onEvent(async (e) => { events.push(e) })

      // First poll — baseline
      await transport.poll()

      // New comment appears
      const newComments = [
        { id: 1, content: { raw: 'LGTM!' }, created_on: '2026-04-20T12:00:00Z' },
      ]
      ;(poller.getComments as ReturnType<typeof vi.fn>).mockResolvedValue(newComments)

      // Second poll
      await transport.poll()
      expect(events).toHaveLength(1)
      expect(events[0].eventKey).toBe('pullrequest:comment_created')
    })

    it('detects PR decline and delivers event', async () => {
      const job = makeJob()
      const backend = makeMockBackend([job])
      const poller = makeMockPoller('OPEN', 0, [])
      const events: InboundEvent[] = []
      transport = new PollingTransport({
        stateBackend: backend,
        prPoller: poller,
        logger,
      })
      transport.onEvent(async (e) => { events.push(e) })

      // First poll
      await transport.poll()

      // PR declined
      ;(poller.getPrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'DECLINED', approvalCount: 0 })

      // Second poll
      await transport.poll()
      expect(events).toHaveLength(1)
      expect(events[0].eventKey).toBe('pullrequest:rejected')
    })

    it('resolves repoSlug from prMappings', async () => {
      const job = makeJob({
        params: {},  // no repoSlug in params
        prMappings: [{ prId: 42, feature: 'f', repoSlug: 'mapped-repo', openedAt: '2026-01-01' }],
      })
      const backend = makeMockBackend([job])
      const poller = makeMockPoller('OPEN', 0, [])
      transport = new PollingTransport({
        stateBackend: backend,
        prPoller: poller,
        logger,
      })

      await transport.poll()
      expect(poller.getPrStatus).toHaveBeenCalledWith('mapped-repo', 42)
    })
  })
})
