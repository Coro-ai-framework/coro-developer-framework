// ── completion-gate.test.ts ─────────────────────────────────────────────────
//
// Lockdown tests for the pure helpers in `src/jobs/completion-gate.ts`.
// The runner.ts integration (re-run phase, retry cap, STATUS_FAILED on
// exhaustion) is covered by `tests/runner/runner.test.ts`; this file
// pins the gate decision logic and the corrective prompt text shape.

import { describe, it, expect } from 'vitest'
import {
  buildJobCompletionBlockPrompt,
  buildJobCompletionFailureMessage,
  buildPhaseAdvanceBlockPrompt,
  buildPhaseAdvanceFailureMessage,
  COMPLETION_GATE_MAX_RETRIES,
  evaluateCompletionGate,
  evaluatePhaseAdvanceGate,
  jobHasWorkItems,
  PHASE_ADVANCE_GATE_MAX_RETRIES,
} from '../../src/jobs/completion-gate'
import { JobType, type Job } from '@coro-ai/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'gate-job-1',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: {},
    triggerSource: 'cli',
    status: 'running',
    phase: 'evaluation',
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
    ...overrides,
  }
}

describe('jobHasWorkItems', () => {
  it('returns false when workItems is empty', () => {
    expect(jobHasWorkItems(makeJob({ workItems: [] }))).toBe(false)
  })

  it('returns true when at least one work item is registered', () => {
    expect(jobHasWorkItems(makeJob({
      workItems: [{ name: 'wi-1', status: 'pending', loopCount: 0 }],
    }))).toBe(true)
  })
})

describe('evaluateCompletionGate', () => {
  it('reports ready when the job has no work items (workflow-agnostic skip)', () => {
    const decision = evaluateCompletionGate(makeJob({ workItems: [] }))
    expect(decision).toEqual({ ready: true, blockingWorkItems: [] })
  })

  it('reports ready when every work item is complete', () => {
    const decision = evaluateCompletionGate(makeJob({
      workItems: [
        { name: 'wi-1', status: 'complete', loopCount: 0 },
        { name: 'wi-2', status: 'complete', loopCount: 1 },
      ],
    }))
    expect(decision.ready).toBe(true)
    expect(decision.blockingWorkItems).toEqual([])
  })

  it('treats escalated work items as satisfying the gate', () => {
    const decision = evaluateCompletionGate(makeJob({
      workItems: [
        { name: 'wi-1', status: 'complete', loopCount: 0 },
        { name: 'wi-2', status: 'escalated', loopCount: 2 },
      ],
    }))
    expect(decision.ready).toBe(true)
  })

  it('blocks completion and surfaces pending work items', () => {
    const decision = evaluateCompletionGate(makeJob({
      workItems: [
        { name: 'wi-1', status: 'complete', loopCount: 0 },
        { name: 'wi-2', status: 'pending', loopCount: 0 },
      ],
    }))
    expect(decision.ready).toBe(false)
    expect(decision.blockingWorkItems.map(w => w.name)).toEqual(['wi-2'])
  })

  it('blocks completion when a work item is in-progress', () => {
    const decision = evaluateCompletionGate(makeJob({
      workItems: [{ name: 'wi-1', status: 'in-progress', loopCount: 1 }],
    }))
    expect(decision.ready).toBe(false)
    expect(decision.blockingWorkItems.map(w => w.name)).toEqual(['wi-1'])
  })
})

describe('buildJobCompletionBlockPrompt', () => {
  it('names every blocking work item and the attempt counter', () => {
    const job = makeJob({
      workItems: [
        { name: 'wi-a', status: 'in-progress', loopCount: 1 },
        { name: 'wi-b', status: 'pending', loopCount: 0 },
      ],
    })
    const decision = evaluateCompletionGate(job)
    const prompt = buildJobCompletionBlockPrompt(job, decision, 2)

    expect(prompt).toContain('[completion-gate]')
    expect(prompt).toContain('wi-a')
    expect(prompt).toContain('wi-b')
    expect(prompt).toContain('in-progress')
    expect(prompt).toContain('pending')
    expect(prompt).toContain(`attempt 2/${COMPLETION_GATE_MAX_RETRIES}`)
  })

  it('summarises prMappings into open vs merged groups when present', () => {
    const job = makeJob({
      workItems: [{ name: 'wi-a', status: 'in-progress', loopCount: 0 }],
      prMappings: [
        { prId: 7, workItem: 'wi-a', repoSlug: 'r', openedAt: '2026-01-01', mergedAt: '2026-01-02' },
        { prId: 8, workItem: 'wi-a', repoSlug: 'r', openedAt: '2026-01-03' },
      ],
    })
    const decision = evaluateCompletionGate(job)
    const prompt = buildJobCompletionBlockPrompt(job, decision, 1)

    expect(prompt).toContain('open=1 [#8]')
    expect(prompt).toContain('merged=1 [#7]')
  })

  it('omits the PR summary when prMappings is empty', () => {
    const job = makeJob({
      workItems: [{ name: 'wi-a', status: 'pending', loopCount: 0 }],
      prMappings: [],
    })
    const decision = evaluateCompletionGate(job)
    const prompt = buildJobCompletionBlockPrompt(job, decision, 1)

    expect(prompt).not.toContain('PR mappings on this job:')
  })
})

describe('buildJobCompletionFailureMessage', () => {
  it('lists the blocking work-item names', () => {
    const job = makeJob({
      workItems: [
        { name: 'wi-a', status: 'pending', loopCount: 0 },
        { name: 'wi-b', status: 'in-progress', loopCount: 4 },
      ],
    })
    const decision = evaluateCompletionGate(job)
    const msg = buildJobCompletionFailureMessage(decision)

    expect(msg).toContain('wi-a')
    expect(msg).toContain('wi-b')
    expect(msg).toContain(`${COMPLETION_GATE_MAX_RETRIES}`)
  })
})

// ── Phase-advance PR-merge gate (#55) ───────────────────────────────────────
//
// A job in review whose current work item's PR is still open (unmerged)
// must not auto-advance to evaluation (or any other next phase). Once the
// PR is merged (or there is no PR mapping to begin with), the implicit
// advance is allowed again.

describe('evaluatePhaseAdvanceGate', () => {
  it('reports ready when there is no current work item', () => {
    const job = makeJob({
      phase: 'review',
      currentWorkItem: null,
      prMappings: [
        { prId: 1, workItem: 'wi-a', repoSlug: 'r', openedAt: '2026-01-01' },
      ],
    })
    expect(evaluatePhaseAdvanceGate(job)).toEqual({ ready: true, openMappings: [] })
  })

  it('reports ready when prMappings is empty (no PR opened yet)', () => {
    const job = makeJob({
      phase: 'review',
      currentWorkItem: 'wi-a',
      prMappings: [],
    })
    expect(evaluatePhaseAdvanceGate(job)).toEqual({ ready: true, openMappings: [] })
  })

  it('blocks when the current work item has an open (unmerged) PR mapping', () => {
    const job = makeJob({
      phase: 'review',
      currentWorkItem: 'wi-a',
      prMappings: [
        { prId: 16, workItem: 'wi-a', repoSlug: 'r', openedAt: '2026-01-01' },
      ],
    })
    const decision = evaluatePhaseAdvanceGate(job)
    expect(decision.ready).toBe(false)
    expect(decision.openMappings).toEqual([
      { prId: 16, workItem: 'wi-a', repoSlug: 'r', openedAt: '2026-01-01' },
    ])
  })

  it('is ready once the current work item PR is merged', () => {
    const job = makeJob({
      phase: 'review',
      currentWorkItem: 'wi-a',
      prMappings: [
        { prId: 16, workItem: 'wi-a', repoSlug: 'r', openedAt: '2026-01-01', mergedAt: '2026-01-02' },
      ],
    })
    expect(evaluatePhaseAdvanceGate(job)).toEqual({ ready: true, openMappings: [] })
  })

  it('ignores open PRs that belong to a different work item', () => {
    const job = makeJob({
      phase: 'review',
      currentWorkItem: 'wi-b',
      prMappings: [
        { prId: 16, workItem: 'wi-a', repoSlug: 'r', openedAt: '2026-01-01' },
      ],
    })
    expect(evaluatePhaseAdvanceGate(job)).toEqual({ ready: true, openMappings: [] })
  })
})

describe('buildPhaseAdvanceBlockPrompt', () => {
  it('names the open PR ids, the next phase, and the retry cap', () => {
    const job = makeJob({
      phase: 'review',
      currentWorkItem: 'wi-a',
      prMappings: [
        { prId: 16, workItem: 'wi-a', repoSlug: 'r', openedAt: '2026-01-01' },
      ],
    })
    const decision = evaluatePhaseAdvanceGate(job)
    const prompt = buildPhaseAdvanceBlockPrompt(job, decision, 'evaluation', 1)

    expect(prompt).toContain('#16')
    expect(prompt).toContain('evaluation')
    expect(prompt).toContain(`${PHASE_ADVANCE_GATE_MAX_RETRIES}`)
  })
})

describe('buildPhaseAdvanceFailureMessage', () => {
  it('lists the open PR ids and the retry cap', () => {
    const job = makeJob({
      phase: 'review',
      currentWorkItem: 'wi-a',
      prMappings: [
        { prId: 16, workItem: 'wi-a', repoSlug: 'r', openedAt: '2026-01-01' },
      ],
    })
    const decision = evaluatePhaseAdvanceGate(job)
    const msg = buildPhaseAdvanceFailureMessage(decision)

    expect(msg).toContain('#16')
    expect(msg).toContain(`${PHASE_ADVANCE_GATE_MAX_RETRIES}`)
  })
})
