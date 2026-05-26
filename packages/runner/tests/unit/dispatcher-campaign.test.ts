// ── dispatcher-campaign.test.ts ──────────────────────────────────────────────
//
// Lockdown tests for `Dispatcher.coordinateCampaign` — the one and only
// place where campaign children are dispatched, the parent is parked on
// failure, and the parent is resumed into `aggregation` once every child
// reaches a terminal state. The test seam stubs the runner module so the
// dispatcher only manipulates state (no real Anthropic calls).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/jobs/runner', () => ({
  // Resolve immediately so dispatchCampaignChild() returns successfully
  // and the coordinator can flip the child to `dispatched`.
  runJob: vi.fn().mockResolvedValue(undefined),
}))

import { Dispatcher } from '../../src/jobs/dispatcher'
import {
  JobType,
  STATUS_COMPLETE,
  STATUS_QUEUED,
  STATUS_AWAITING_DEVELOPER_INPUT,
  type Job,
  type CampaignChild,
  type JobInput,
} from '@coro-ai/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeChild(overrides: Partial<CampaignChild> = {}): CampaignChild {
  return {
    name: 'a',
    description: 'work',
    params: {},
    dependsOn: [],
    status: 'pending',
    ...overrides,
  }
}

function makeCampaignJob(
  children: CampaignChild[],
  overrides: Partial<Job> = {},
): Job {
  return {
    id: 'campaign-1',
    type: JobType.Job,
    workflowPath: 'workflows/campaign/workflow.md',
    params: { repoSlug: 'svc' },
    triggerSource: 'cli',
    status: STATUS_QUEUED,
    phase: 'coordination',
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
    campaignChildren: children,
    ...overrides,
  }
}

interface StubBackend {
  jobs: Map<string, Job>
  getJob: ReturnType<typeof vi.fn>
  updateJob: ReturnType<typeof vi.fn>
  appendLog: ReturnType<typeof vi.fn>
  createJob: ReturnType<typeof vi.fn>
}

function makeBackend(jobs: Job[]): StubBackend {
  const map = new Map(jobs.map(j => [j.id, j]))
  return {
    jobs: map,
    getJob: vi.fn(async (id: string) => map.get(id) ?? null),
    updateJob: vi.fn(async (id: string, patch: Partial<Job>) => {
      const current = map.get(id)
      if (!current) throw new Error(`updateJob: missing ${id}`)
      const next = { ...current, ...patch }
      map.set(id, next)
      return next
    }),
    appendLog: vi.fn(async () => undefined),
    // dispatchCampaignChild calls createJob(JobInput) — we mint a fresh id
    // and return a minimal Job shape so the coordinator can mutate it.
    createJob: vi.fn(async (input: JobInput) => {
      const id = `child-${map.size + 1}`
      const job: Job = {
        id,
        type: input.type === 'self-update' ? JobType.SelfUpdate : JobType.Job,
        workflowPath: input.workflowPath ?? 'workflows/job/workflow.md',
        params: input.params,
        triggerSource: input.triggerSource ?? 'internal',
        status: STATUS_QUEUED,
        phase: 'planning',
        currentWorkItem: null,
        workItems: [],
        workItemLoopCount: 0,
        prMappings: [],
        interactive: false,
        artifacts: [],
        insights: Array.isArray(input.initialInsights) ? [...input.initialInsights] : [],
        tokenUsage: emptyTokenUsage(),
        phaseUsage: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }
      map.set(id, job)
      return job
    }),
  }
}

function makeDispatcher(backend: StubBackend) {
  const ctx = {
    stateBackend: backend,
    settings: {
      paths: { coroIntelligenceDir: '/intel', workingDir: '/working', baseLayerDir: '/base' },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    tenantContext: { tenantId: 'solo', kind: 'solo' as const },
    plugins: { all: () => [] },
  }
  return new Dispatcher(ctx as never)
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Coordinator: halt-on-failure ─────────────────────────────────────────────

describe('Dispatcher.coordinateCampaign — halt on failure', () => {
  it('parks the parent at AWAITING_DEVELOPER_INPUT when a child has failed', async () => {
    const parent = makeCampaignJob([
      makeChild({ name: 'a', status: 'failed' }),
      makeChild({ name: 'b', status: 'pending', dependsOn: ['a'] }),
    ])
    const backend = makeBackend([parent])
    const dispatcher = makeDispatcher(backend)

    await dispatcher.coordinateCampaign(parent.id)

    const stored = backend.jobs.get(parent.id)!
    expect(stored.status).toBe(STATUS_AWAITING_DEVELOPER_INPUT)
    expect(stored.escalationMessage).toContain('child')
    expect(stored.escalationMessage).toContain('a')
    expect(stored.awaitingEvent).toMatch(/developer-input/i)
  })

  it('does not re-park an already-parked parent (idempotent)', async () => {
    const parent = makeCampaignJob(
      [
        makeChild({ name: 'a', status: 'failed' }),
        makeChild({ name: 'b', status: 'failed' }),
      ],
      { status: STATUS_AWAITING_DEVELOPER_INPUT },
    )
    const backend = makeBackend([parent])
    const dispatcher = makeDispatcher(backend)

    await dispatcher.coordinateCampaign(parent.id)

    expect(backend.updateJob).not.toHaveBeenCalled()
  })

  it('also halts on escalated children (not just failed)', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'escalated' })])
    const backend = makeBackend([parent])
    const dispatcher = makeDispatcher(backend)

    await dispatcher.coordinateCampaign(parent.id)

    expect(backend.jobs.get(parent.id)!.status).toBe(STATUS_AWAITING_DEVELOPER_INPUT)
  })
})

// ── Coordinator: un-park after halt resolution ────────────────────────────
//
// When a halted child is resumed or abandoned and no halted children remain,
// the parent should transition out of awaiting-developer-input back to
// awaiting-children so the dashboard stops showing the halt banner while
// in-flight work continues.

describe('Dispatcher.coordinateCampaign — un-park after halt resolution', () => {
  it('un-parks parent to awaiting-children when no halted children remain', async () => {
    const { STATUS_AWAITING_CHILDREN } = await import('@coro-ai/cloud-protocol')
    const parent = makeCampaignJob(
      [
        // Recently-resumed child re-dispatched, sibling still in flight.
        makeChild({ name: 'a', status: 'dispatched', jobId: 'job-a' }),
        makeChild({ name: 'b', status: 'pending' }),
      ],
      { status: STATUS_AWAITING_DEVELOPER_INPUT, escalationMessage: 'previously halted' },
    )
    const backend = makeBackend([parent])
    const dispatcher = makeDispatcher(backend)

    await dispatcher.coordinateCampaign(parent.id)

    const stored = backend.jobs.get(parent.id)!
    expect(stored.status).toBe(STATUS_AWAITING_CHILDREN)
    expect(stored.escalationMessage).toBeUndefined()
    expect(stored.awaitingEvent).toBeUndefined()
  })

  it('does NOT un-park if the parent was never halted (status untouched)', async () => {
    const parent = makeCampaignJob([
      makeChild({ name: 'a', status: 'dispatched', jobId: 'job-a' }),
      makeChild({ name: 'b', status: 'pending' }),
    ])
    const backend = makeBackend([parent])
    const dispatcher = makeDispatcher(backend)

    await dispatcher.coordinateCampaign(parent.id)

    const stored = backend.jobs.get(parent.id)!
    expect(stored.status).toBe(STATUS_QUEUED) // unchanged from fixture
  })
})

// ── Coordinator: all-terminal → aggregation ──────────────────────────────────

describe('Dispatcher.coordinateCampaign — advance to aggregation', () => {
  it('resumes the parent into the aggregation phase when every child is terminal', async () => {
    const parent = makeCampaignJob([
      makeChild({ name: 'a', status: 'complete' }),
      makeChild({ name: 'b', status: 'skipped' }),
      makeChild({ name: 'c', status: 'cancelled' }),
    ])
    const backend = makeBackend([parent])
    const dispatcher = makeDispatcher(backend)

    // Spy on resumeJob to confirm coordinator delegates rather than mutating
    // the phase directly. (Production resumeJob does the actual phase swap.)
    const resumeSpy = (vi.spyOn(dispatcher, 'resumeJob') as unknown as {
      mockImplementation(fn: (...args: unknown[]) => unknown): unknown
    }).mockImplementation(async () => undefined) as unknown as ReturnType<typeof vi.fn>

    await dispatcher.coordinateCampaign(parent.id)

    expect(resumeSpy).toHaveBeenCalledWith(parent.id, 'aggregation', true)
    expect(backend.appendLog).toHaveBeenCalledWith(
      parent.id,
      expect.stringContaining('All 3 children terminal'),
    )
  })

  it('does NOT re-resume if the parent is already in the aggregation phase', async () => {
    const parent = makeCampaignJob(
      [makeChild({ name: 'a', status: 'complete' })],
      { phase: 'aggregation' },
    )
    const backend = makeBackend([parent])
    const dispatcher = makeDispatcher(backend)
    const resumeSpy = (vi.spyOn(dispatcher, 'resumeJob') as unknown as {
      mockImplementation(fn: (...args: unknown[]) => unknown): unknown
    }).mockImplementation(async () => undefined) as unknown as ReturnType<typeof vi.fn>

    await dispatcher.coordinateCampaign(parent.id)

    expect(resumeSpy).not.toHaveBeenCalled()
  })
})

// ── Coordinator: dispatch ready slots ────────────────────────────────────────

describe('Dispatcher.coordinateCampaign — dispatch sweep', () => {
  it('does nothing for a non-campaign job (logs warn and returns)', async () => {
    const parent = makeCampaignJob([])
    delete parent.campaignChildren
    const backend = makeBackend([parent])
    const dispatcher = makeDispatcher(backend)

    await dispatcher.coordinateCampaign(parent.id)
    expect(backend.updateJob).not.toHaveBeenCalled()
  })

  it('does nothing for a missing job', async () => {
    const backend = makeBackend([])
    const dispatcher = makeDispatcher(backend)

    await expect(dispatcher.coordinateCampaign('does-not-exist')).resolves.toBeUndefined()
    expect(backend.updateJob).not.toHaveBeenCalled()
  })

  it('does nothing for an empty campaign', async () => {
    const parent = makeCampaignJob([])
    const backend = makeBackend([parent])
    const dispatcher = makeDispatcher(backend)

    await dispatcher.coordinateCampaign(parent.id)
    expect(backend.updateJob).not.toHaveBeenCalled()
  })
})

// ── Sibling insight propagation ────────────────────────────────────────────────

describe('Campaign sibling insights — rejected filtering', () => {
  it('does not seed rejected insights when dispatching a ready child', async () => {
    const parent = makeCampaignJob([
      makeChild({ name: 'a', status: 'ready' }),
    ], {
      campaignAggregatedInsights: [
        {
          phase: 'coding',
          category: 'workaround',
          summary: 'Good recipe',
          detail: 'Keep',
          status: 'approved',
          sourceChildName: 'prior',
        },
        {
          phase: 'coding',
          category: 'spec-ambiguity',
          summary: 'Bad recipe',
          detail: 'Drop',
          status: 'rejected',
          sourceChildName: 'prior',
        },
      ],
    })
    const backend = makeBackend([parent])
    const dispatcher = makeDispatcher(backend)

    await dispatcher.coordinateCampaign(parent.id)

    expect(backend.createJob).toHaveBeenCalledTimes(1)
    const input = vi.mocked(backend.createJob).mock.calls[0]![0] as JobInput
    expect(input.initialInsights).toHaveLength(1)
    expect(input.initialInsights![0]?.summary).toBe('Good recipe')
  })

  it('does not aggregate rejected insights onto the parent when a child stops', async () => {
    const parent = makeCampaignJob([
      makeChild({
        name: 'a',
        status: 'dispatched',
        jobId: 'child-a',
      }),
    ])
    const childJob: Job = {
      ...makeCampaignJob([]),
      id: 'child-a',
      campaignParentId: parent.id,
      status: STATUS_COMPLETE,
      params: { campaignChildName: 'a', campaignParentId: parent.id },
      insights: [
        {
          phase: 'coding',
          category: 'workaround',
          summary: 'Keep',
          detail: 'd',
          status: 'approved',
        },
        {
          phase: 'coding',
          category: 'workaround',
          summary: 'Drop',
          detail: 'd',
          status: 'rejected',
        },
      ],
    }
    const backend = makeBackend([parent, childJob])
    const dispatcher = makeDispatcher(backend)

    await (dispatcher as unknown as { onChildJobStopped: (j: Job) => Promise<void> })
      .onChildJobStopped(childJob)

    const stored = backend.jobs.get(parent.id)!
    expect(stored.campaignAggregatedInsights).toHaveLength(1)
    expect(stored.campaignAggregatedInsights![0]?.summary).toBe('Keep')
    expect(stored.campaignAggregatedInsights![0]?.sourceChildName).toBe('a')
  })
})

// ── Live-control entry points ────────────────────────────────────────────────

describe('Dispatcher.campaign{Skip,Cancel,Rerun}Child', () => {
  it('campaignSkipChild marks the child skipped and re-runs the coordinator', async () => {
    const parent = makeCampaignJob([
      makeChild({ name: 'a', status: 'pending' }),
      makeChild({ name: 'b', status: 'pending', dependsOn: ['a'] }),
    ])
    const backend = makeBackend([parent])
    const dispatcher = makeDispatcher(backend)
    const coordSpy = vi.spyOn(dispatcher, 'coordinateCampaign')

    await dispatcher.campaignSkipChild(parent.id, 'a', 'redundant')

    const stored = backend.jobs.get(parent.id)!
    expect(stored.campaignChildren!.find(c => c.name === 'a')!.status).toBe('skipped')
    // Downstream child b unblocks → reconcile promotes to ready → coordinator
    // sweep dispatches it on the same turn (status becomes 'dispatched').
    expect(stored.campaignChildren!.find(c => c.name === 'b')!.status).toBe('dispatched')
    expect(coordSpy).toHaveBeenCalledWith(parent.id)
  })

  it('campaignCancelChild marks the child cancelled and re-runs the coordinator', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'pending' })])
    const backend = makeBackend([parent])
    const dispatcher = makeDispatcher(backend)
    const coordSpy = vi.spyOn(dispatcher, 'coordinateCampaign')

    await dispatcher.campaignCancelChild(parent.id, 'a')

    expect(backend.jobs.get(parent.id)!.campaignChildren![0].status).toBe('cancelled')
    expect(coordSpy).toHaveBeenCalledWith(parent.id)
  })

  it('campaignRerunChild resets a failed child and re-runs the coordinator', async () => {
    const parent = makeCampaignJob([
      makeChild({
        name: 'a',
        status: 'failed',
        jobId: 'old-child',
        completedAt: '2026-01-01T00:00:00Z',
      }),
    ])
    const backend = makeBackend([parent])
    const dispatcher = makeDispatcher(backend)
    const coordSpy = vi.spyOn(dispatcher, 'coordinateCampaign')

    await dispatcher.campaignRerunChild(parent.id, 'a', 'fixed')

    const stored = backend.jobs.get(parent.id)!.campaignChildren![0]
    // Reset → reconcile promotes to ready → coordinator sweep dispatches.
    expect(stored.status).toBe('dispatched')
    expect(stored.jobId).toBeDefined()
    expect(stored.jobId).not.toBe('old-child')
    expect(coordSpy).toHaveBeenCalledWith(parent.id)
  })
})
