// ── campaign-tools.test.ts ───────────────────────────────────────────────────
//
// Lockdown tests for the pure helpers and live-control mutations in
// `src/tools/campaign.ts`. The dispatcher coordinator (`coordinateCampaign`)
// is tested separately in dispatcher-campaign.test.ts.
//
// What we cover here:
//   reconcileReady       — pending → ready promotion when deps satisfied
//   detectCycle          — cycle detection in the dependency graph
//   jobStatusToChildStatus — terminal job-status to child-status mapping
//   campaignSkipChild    — illegal/legal source statuses + log line shape
//   campaignRerunChild   — only terminal sources may rerun; metadata is reset
//   campaignCancelChild  — cascade-cancel of dispatched child Job + child mutate

import { describe, it, expect, vi } from 'vitest'
import {
  campaignSkipChild,
  campaignRerunChild,
  campaignCancelChild,
  campaignAbandonChild,
  campaignResumeChild,
  reconcileReady,
  detectCycle,
  jobStatusToChildStatus,
} from '../../src/tools/campaign'
import {
  JobType,
  STATUS_QUEUED,
  STATUS_COMPLETE,
  STATUS_FAILED,
  STATUS_ESCALATED,
  STATUS_CANCELLED,
  type Job,
  type CampaignChild,
} from '@coro-ai/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'
import type { ToolContext } from '../../src/tools/types'

const RUNNING = 'running-coding'

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeChild(overrides: Partial<CampaignChild> = {}): CampaignChild {
  return {
    name: 'child-a',
    description: 'do thing',
    params: {},
    dependsOn: [],
    status: 'pending',
    ...overrides,
  }
}

function makeCampaignJob(children: CampaignChild[]): Job {
  return {
    id: 'campaign-1',
    type: JobType.Job,
    workflowPath: 'workflows/campaign/workflow.md',
    params: {},
    triggerSource: 'cli',
    status: STATUS_QUEUED,
    phase: 'campaign-coordination',
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
  }
}

interface BackendStub {
  jobs: Map<string, Job>
  getJob: ReturnType<typeof vi.fn>
  updateJob: ReturnType<typeof vi.fn>
  appendLog: ReturnType<typeof vi.fn>
}

function makeBackend(jobs: Job[]): BackendStub {
  const map = new Map(jobs.map(j => [j.id, j]))
  const getJob = vi.fn(async (id: string) => map.get(id) ?? null)
  const updateJob = vi.fn(async (id: string, patch: Partial<Job>) => {
    const current = map.get(id)
    if (!current) throw new Error(`updateJob: missing ${id}`)
    const next = { ...current, ...patch }
    map.set(id, next)
    return next
  })
  const appendLog = vi.fn(async () => undefined)
  return { jobs: map, getJob, updateJob, appendLog }
}

function makeCtx(parentJob: Job, backend: BackendStub): ToolContext {
  return {
    job: parentJob,
    stateBackend: backend as unknown as ToolContext['stateBackend'],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
  } as unknown as ToolContext
}

// ── reconcileReady ───────────────────────────────────────────────────────────

describe('reconcileReady', () => {
  it('promotes a root pending child (no deps) to ready', () => {
    const out = reconcileReady([makeChild({ name: 'a' })])
    expect(out[0].status).toBe('ready')
  })

  it('promotes a pending child once all deps are satisfied (complete)', () => {
    const out = reconcileReady([
      makeChild({ name: 'a', status: 'complete' }),
      makeChild({ name: 'b', dependsOn: ['a'] }),
    ])
    expect(out[1].status).toBe('ready')
  })

  it('treats skipped and cancelled deps as satisfied', () => {
    const out = reconcileReady([
      makeChild({ name: 'a', status: 'skipped' }),
      makeChild({ name: 'b', status: 'cancelled' }),
      makeChild({ name: 'c', dependsOn: ['a', 'b'] }),
    ])
    expect(out[2].status).toBe('ready')
  })

  it('does NOT promote when any dep is failed or escalated', () => {
    const out = reconcileReady([
      makeChild({ name: 'a', status: 'failed' }),
      makeChild({ name: 'b', dependsOn: ['a'] }),
    ])
    expect(out[1].status).toBe('pending')
  })

  it('leaves non-pending children untouched (idempotent)', () => {
    const input = [
      makeChild({ name: 'a', status: 'dispatched' }),
      makeChild({ name: 'b', status: 'complete' }),
      makeChild({ name: 'c', status: 'ready' }),
    ]
    const out = reconcileReady(input)
    expect(out.map(c => c.status)).toEqual(['dispatched', 'complete', 'ready'])
  })

  it('drops ready promotion when a referenced dep does not exist (defensive)', () => {
    // A planner-bug-detector: dependsOn references an unknown child name.
    // We refuse to promote rather than spuriously dispatching.
    const out = reconcileReady([makeChild({ name: 'b', dependsOn: ['ghost'] })])
    expect(out[0].status).toBe('pending')
  })
})

// ── detectCycle ──────────────────────────────────────────────────────────────

describe('detectCycle', () => {
  it('returns null on a DAG (linear chain)', () => {
    expect(
      detectCycle([
        makeChild({ name: 'a' }),
        makeChild({ name: 'b', dependsOn: ['a'] }),
        makeChild({ name: 'c', dependsOn: ['b'] }),
      ]),
    ).toBeNull()
  })

  it('returns null on a diamond (shared ancestor)', () => {
    expect(
      detectCycle([
        makeChild({ name: 'a' }),
        makeChild({ name: 'b', dependsOn: ['a'] }),
        makeChild({ name: 'c', dependsOn: ['a'] }),
        makeChild({ name: 'd', dependsOn: ['b', 'c'] }),
      ]),
    ).toBeNull()
  })

  it('detects a self-loop', () => {
    const cycle = detectCycle([makeChild({ name: 'a', dependsOn: ['a'] })])
    expect(cycle).not.toBeNull()
    expect(cycle![0]).toBe('a')
    expect(cycle![cycle!.length - 1]).toBe('a')
  })

  it('detects a 3-node cycle and includes every node', () => {
    const cycle = detectCycle([
      makeChild({ name: 'a', dependsOn: ['c'] }),
      makeChild({ name: 'b', dependsOn: ['a'] }),
      makeChild({ name: 'c', dependsOn: ['b'] }),
    ])
    expect(cycle).not.toBeNull()
    // Closed cycle: starts and ends at the same node, contains a/b/c.
    expect(cycle![0]).toBe(cycle![cycle!.length - 1])
    const unique = new Set(cycle)
    expect(unique).toEqual(new Set(['a', 'b', 'c']))
  })

  it('returns null for an empty graph', () => {
    expect(detectCycle([])).toBeNull()
  })
})

// ── jobStatusToChildStatus ───────────────────────────────────────────────────

describe('jobStatusToChildStatus', () => {
  it.each([
    [STATUS_COMPLETE, 'complete'],
    [STATUS_FAILED, 'failed'],
    [STATUS_ESCALATED, 'escalated'],
    [STATUS_CANCELLED, 'cancelled'],
  ])('maps job status %s → child status %s', (jobStatus, expected) => {
    expect(jobStatusToChildStatus(jobStatus)).toBe(expected)
  })

  it('returns null for non-terminal job statuses', () => {
    expect(jobStatusToChildStatus(RUNNING)).toBeNull()
    expect(jobStatusToChildStatus('queued')).toBeNull()
  })
})

// ── campaignSkipChild ────────────────────────────────────────────────────────

describe('campaignSkipChild', () => {
  it('marks a pending child skipped and writes the structured log line', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'pending' })])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    const result = await campaignSkipChild({ name: 'a', reason: 'redundant' }, ctx)

    expect(result).toEqual({ ok: true, name: 'a', status: 'skipped' })
    const stored = backend.jobs.get(parent.id)!
    expect(stored.campaignChildren![0].status).toBe('skipped')
    expect(stored.campaignChildren![0].completedAt).toBeDefined()
    expect(backend.appendLog).toHaveBeenCalledWith(
      parent.id,
      expect.stringContaining('Skipped child "a" — redundant'),
    )
  })

  it('refuses to skip a child that is already complete', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'complete' })])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    await expect(campaignSkipChild({ name: 'a' }, ctx)).rejects.toThrow(/already complete/i)
    expect(backend.updateJob).not.toHaveBeenCalled()
  })

  it('promotes downstream dependents when skipping unblocks them', async () => {
    const parent = makeCampaignJob([
      makeChild({ name: 'a', status: 'pending' }),
      makeChild({ name: 'b', dependsOn: ['a'], status: 'pending' }),
    ])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    await campaignSkipChild({ name: 'a' }, ctx)

    const stored = backend.jobs.get(parent.id)!
    expect(stored.campaignChildren![0].status).toBe('skipped')
    expect(stored.campaignChildren![1].status).toBe('ready')
  })

  it('rejects when the named child does not exist', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a' })])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    await expect(campaignSkipChild({ name: 'ghost' }, ctx)).rejects.toThrow(/No child named "ghost"/)
  })

  it('rejects when the parent job is not a campaign', async () => {
    const parent = makeCampaignJob([])
    delete parent.campaignChildren
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    await expect(campaignSkipChild({ name: 'a' }, ctx)).rejects.toThrow(/not a campaign/i)
  })
})

// ── campaignRerunChild ───────────────────────────────────────────────────────

describe('campaignRerunChild', () => {
  it('resets a failed child to pending (then reconcile may auto-promote to ready) and clears jobId/timestamps', async () => {
    const parent = makeCampaignJob([
      makeChild({
        name: 'a',
        status: 'failed',
        jobId: 'old-child-job',
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z',
        // Add an unsatisfied dep so reconcile keeps it `pending` and we can
        // observe the reset itself rather than the immediate promotion.
        dependsOn: ['blocker'],
      }),
      makeChild({ name: 'blocker', status: 'pending' }),
    ])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    await campaignRerunChild({ name: 'a', reason: 'fixed plan' }, ctx)

    const stored = backend.jobs.get(parent.id)!
    expect(stored.campaignChildren![0].status).toBe('pending')
    expect(stored.campaignChildren![0].jobId).toBeUndefined()
    expect(stored.campaignChildren![0].startedAt).toBeUndefined()
    expect(stored.campaignChildren![0].completedAt).toBeUndefined()
  })

  it('refuses to rerun a non-terminal child', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'dispatched' })])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    await expect(campaignRerunChild({ name: 'a' }, ctx)).rejects.toThrow(/currently dispatched/)
  })

  it('rerun then reconcile re-promotes the root', async () => {
    const parent = makeCampaignJob([
      makeChild({ name: 'root', status: 'failed', jobId: 'old', dependsOn: [] }),
    ])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    await campaignRerunChild({ name: 'root' }, ctx)

    const stored = backend.jobs.get(parent.id)!
    expect(stored.campaignChildren![0].status).toBe('ready')
  })
})

// ── campaignCancelChild ──────────────────────────────────────────────────────

describe('campaignCancelChild', () => {
  it('cascade-cancels a running child Job before marking the child cancelled', async () => {
    const childJob: Job = {
      id: 'child-running-1',
      type: JobType.Job,
      workflowPath: 'workflows/job/workflow.md',
      params: {},
      triggerSource: 'cli',
      status: 'running-coding',
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
    }
    const parent = makeCampaignJob([
      makeChild({ name: 'a', status: 'dispatched', jobId: childJob.id }),
    ])
    const backend = makeBackend([parent, childJob])
    const ctx = makeCtx(parent, backend)

    await campaignCancelChild({ name: 'a', reason: 'descope' }, ctx)

    expect(backend.jobs.get(childJob.id)!.status).toBe(STATUS_CANCELLED)
    const storedParent = backend.jobs.get(parent.id)!
    expect(storedParent.campaignChildren![0].status).toBe('cancelled')
    expect(storedParent.campaignChildren![0].completedAt).toBeDefined()
  })

  it('does not cascade when the child Job already reached a stopped status', async () => {
    const childJob: Job = {
      id: 'child-failed-1',
      type: JobType.Job,
      workflowPath: 'workflows/job/workflow.md',
      params: {},
      triggerSource: 'cli',
      status: STATUS_FAILED,
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
    }
    const parent = makeCampaignJob([
      makeChild({ name: 'a', status: 'failed', jobId: childJob.id }),
    ])
    const backend = makeBackend([parent, childJob])
    const ctx = makeCtx(parent, backend)

    await campaignCancelChild({ name: 'a' }, ctx)

    // Child Job stays at STATUS_FAILED (cascade is a no-op).
    expect(backend.jobs.get(childJob.id)!.status).toBe(STATUS_FAILED)
    expect(backend.jobs.get(parent.id)!.campaignChildren![0].status).toBe('cancelled')
  })

  it('refuses to cancel a child that is already complete (work was accepted)', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'complete' })])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    await expect(campaignCancelChild({ name: 'a' }, ctx)).rejects.toThrow(/already complete/)
  })

  it('refuses to cancel a child that is already cancelled', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'cancelled' })])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    await expect(campaignCancelChild({ name: 'a' }, ctx)).rejects.toThrow(/already cancelled/)
  })

  it('promotes downstream dependents (cancelled is a satisfied dep)', async () => {
    const parent = makeCampaignJob([
      makeChild({ name: 'a', status: 'pending' }),
      makeChild({ name: 'b', status: 'pending', dependsOn: ['a'] }),
    ])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    await campaignCancelChild({ name: 'a' }, ctx)

    const stored = backend.jobs.get(parent.id)!
    expect(stored.campaignChildren![0].status).toBe('cancelled')
    expect(stored.campaignChildren![1].status).toBe('ready')
  })
})

// ── softened campaignSkipChild on failed/escalated ───────────────────────────
//
// Previously skip on a failed/escalated child threw `already failed`. The
// dashboard's bulk "skip all halted" path turned that into a 500 storm.
// The new behaviour: skip on failed/escalated routes internally to cancel
// (identical downstream semantics — both unblock dependents).

describe('campaignSkipChild — softened on terminal-failed', () => {
  it('converts skip-on-failed into cancel (idempotent UX, same dep semantics)', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'failed' })])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    const result = await campaignSkipChild({ name: 'a' }, ctx)
    expect(result.status).toBe('cancelled')
    expect(backend.jobs.get(parent.id)!.campaignChildren![0].status).toBe('cancelled')
  })

  it('converts skip-on-escalated into cancel', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'escalated' })])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    const result = await campaignSkipChild({ name: 'a' }, ctx)
    expect(result.status).toBe('cancelled')
  })

  it('skip-on-already-cancelled is idempotent (no throw)', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'cancelled' })])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    const result = await campaignSkipChild({ name: 'a' }, ctx)
    expect(result.status).toBe('cancelled')
  })

  it('skip-on-complete still throws (accepted work is immutable)', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'complete' })])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    await expect(campaignSkipChild({ name: 'a' }, ctx)).rejects.toThrow(/already complete/i)
  })
})

// ── campaignAbandonChild ─────────────────────────────────────────────────────

describe('campaignAbandonChild', () => {
  it('abandons a failed child (routes to cancel under the hood)', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'failed' })])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    const result = await campaignAbandonChild({ name: 'a' }, ctx)
    expect(result).toEqual({ ok: true, name: 'a', status: 'cancelled' })
    expect(backend.jobs.get(parent.id)!.campaignChildren![0].status).toBe('cancelled')
  })

  it('is idempotent on already-cancelled (returns 200-no-op, does NOT throw)', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'cancelled' })])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    const result = await campaignAbandonChild({ name: 'a' }, ctx)
    expect(result).toEqual({ ok: true, name: 'a', status: 'cancelled' })
    // No mutation written for the no-op.
    expect(backend.updateJob).not.toHaveBeenCalled()
  })

  it('is idempotent on already-skipped', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'skipped' })])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    const result = await campaignAbandonChild({ name: 'a' }, ctx)
    expect(result.status).toBe('skipped')
    expect(backend.updateJob).not.toHaveBeenCalled()
  })

  it('refuses on complete (work was accepted)', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'complete' })])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    await expect(campaignAbandonChild({ name: 'a' }, ctx)).rejects.toThrow(/already complete/i)
  })

  it('promotes downstream dependents (cancelled is a satisfied dep)', async () => {
    const parent = makeCampaignJob([
      makeChild({ name: 'a', status: 'failed' }),
      makeChild({ name: 'b', status: 'pending', dependsOn: ['a'] }),
    ])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    await campaignAbandonChild({ name: 'a' }, ctx)
    expect(backend.jobs.get(parent.id)!.campaignChildren![1].status).toBe('ready')
  })
})

// ── campaignResumeChild ──────────────────────────────────────────────────────

describe('campaignResumeChild', () => {
  it('marks a failed child as dispatched and returns the underlying child Job id', async () => {
    const parent = makeCampaignJob([
      makeChild({
        name: 'a',
        status: 'failed',
        jobId: 'child-job-1',
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z',
      }),
    ])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    const result = await campaignResumeChild({ name: 'a' }, ctx)
    expect(result).toEqual({
      ok: true,
      name: 'a',
      status: 'dispatched',
      childJobId: 'child-job-1',
    })
    const stored = backend.jobs.get(parent.id)!
    expect(stored.campaignChildren![0].status).toBe('dispatched')
    expect(stored.campaignChildren![0].completedAt).toBeUndefined()
    // Preserves jobId and startedAt (in-place resume, not fresh job).
    expect(stored.campaignChildren![0].jobId).toBe('child-job-1')
    expect(stored.campaignChildren![0].startedAt).toBe('2026-01-01T00:00:00Z')
  })

  it('works on escalated', async () => {
    const parent = makeCampaignJob([
      makeChild({ name: 'a', status: 'escalated', jobId: 'child-job-2' }),
    ])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    const result = await campaignResumeChild({ name: 'a' }, ctx)
    expect(result.childJobId).toBe('child-job-2')
    expect(backend.jobs.get(parent.id)!.campaignChildren![0].status).toBe('dispatched')
  })

  it('refuses on non-failed / non-escalated statuses', async () => {
    for (const status of ['pending', 'ready', 'dispatched', 'complete', 'skipped', 'cancelled'] as const) {
      const parent = makeCampaignJob([makeChild({ name: 'a', status, jobId: 'x' })])
      const backend = makeBackend([parent])
      const ctx = makeCtx(parent, backend)
      await expect(campaignResumeChild({ name: 'a' }, ctx)).rejects.toThrow(/Resume only applies/i)
    }
  })

  it('refuses when no child Job id is recorded (use rerun for a fresh dispatch)', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'failed' })])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    await expect(campaignResumeChild({ name: 'a' }, ctx)).rejects.toThrow(/no underlying child Job id/i)
  })

  it('rejects when the named child does not exist', async () => {
    const parent = makeCampaignJob([makeChild({ name: 'a', status: 'failed', jobId: 'x' })])
    const backend = makeBackend([parent])
    const ctx = makeCtx(parent, backend)

    await expect(campaignResumeChild({ name: 'ghost' }, ctx)).rejects.toThrow(/No child named "ghost"/)
  })
})
