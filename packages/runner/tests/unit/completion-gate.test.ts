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
  COMPLETION_GATE_MAX_RETRIES,
  evaluateCompletionGate,
  jobHasWorkItems,
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
