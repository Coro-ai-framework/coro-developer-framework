// ── types-campaign.test.ts ───────────────────────────────────────────────────
//
// Lockdown tests for the campaign-aware type guards in `src/jobs/types.ts`.
// These guards are the single source of truth the dispatcher coordinator,
// the campaign tools, and the dashboard all depend on. The PhaseExecutor
// refactor must not change their semantics.

import { describe, it, expect } from 'vitest'
import {
  JobType,
  STATUS_QUEUED,
  type Job,
  type CampaignChildStatus,
} from '@coro/cloud-protocol'
import {
  isCampaignJob,
  isEpicAllowed,
  isTerminalChildStatus,
  isSatisfiedChildStatus,
  emptyTokenUsage,
} from '../../src/jobs/helpers'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: {},
    triggerSource: 'cli',
    status: STATUS_QUEUED,
    phase: 'planning',
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

describe('isCampaignJob', () => {
  it('returns true when campaignChildren is an empty array (just-promoted campaign)', () => {
    expect(isCampaignJob(makeJob({ campaignChildren: [] }))).toBe(true)
  })

  it('returns true when campaignChildren contains entries', () => {
    const job = makeJob({
      campaignChildren: [
        { name: 'a', description: 'd', params: {}, dependsOn: [], status: 'pending' },
      ],
    })
    expect(isCampaignJob(job)).toBe(true)
  })

  it('returns false when campaignChildren is missing', () => {
    expect(isCampaignJob(makeJob())).toBe(false)
  })

  it('returns false when campaignChildren is not an array (defensive)', () => {
    const job = makeJob({ campaignChildren: undefined })
    expect(isCampaignJob(job)).toBe(false)
  })

  it('does not classify by workflowPath (rename-safe)', () => {
    // Documented contract: tenants may rename the campaign workflow file.
    // Classification keys off the data shape, never the path.
    const job = makeJob({ workflowPath: 'workflows/giant-epic/workflow.md' })
    expect(isCampaignJob(job)).toBe(false)
  })
})

describe('isEpicAllowed', () => {
  it('returns true by default (epicAllowed not set)', () => {
    expect(isEpicAllowed(makeJob())).toBe(true)
  })

  it('returns true when epicAllowed === true', () => {
    expect(isEpicAllowed(makeJob({ params: { epicAllowed: true } }))).toBe(true)
  })

  it('returns false when epicAllowed === false (campaign children)', () => {
    expect(isEpicAllowed(makeJob({ params: { epicAllowed: false } }))).toBe(false)
  })

  it('treats truthy non-boolean values as allowed (only explicit `false` blocks)', () => {
    expect(isEpicAllowed(makeJob({ params: { epicAllowed: 0 } }))).toBe(true)
    expect(isEpicAllowed(makeJob({ params: { epicAllowed: null } }))).toBe(true)
  })
})

describe('isTerminalChildStatus', () => {
  const TERMINAL: CampaignChildStatus[] = [
    'complete',
    'failed',
    'escalated',
    'skipped',
    'cancelled',
  ]
  const NON_TERMINAL: CampaignChildStatus[] = ['pending', 'ready', 'dispatched']

  it.each(TERMINAL)('marks %s as terminal', status => {
    expect(isTerminalChildStatus(status)).toBe(true)
  })

  it.each(NON_TERMINAL)('marks %s as non-terminal', status => {
    expect(isTerminalChildStatus(status)).toBe(false)
  })
})

describe('isSatisfiedChildStatus', () => {
  // "Satisfied" = downstream dependents may proceed. Failures/escalations
  // are terminal but block dependents until a human resolves the parent.
  const SATISFIED: CampaignChildStatus[] = ['complete', 'skipped', 'cancelled']
  const UNSATISFIED: CampaignChildStatus[] = [
    'pending',
    'ready',
    'dispatched',
    'failed',
    'escalated',
  ]

  it.each(SATISFIED)('marks %s as satisfied (dependents may run)', status => {
    expect(isSatisfiedChildStatus(status)).toBe(true)
  })

  it.each(UNSATISFIED)('marks %s as unsatisfied (dependents stay blocked)', status => {
    expect(isSatisfiedChildStatus(status)).toBe(false)
  })

  it('failed and escalated are terminal but NOT satisfied (halts dependents)', () => {
    // Critical regression guard: if these ever became satisfied, a failed
    // child would silently unblock its dependents instead of halting the
    // campaign for human review.
    expect(isTerminalChildStatus('failed')).toBe(true)
    expect(isSatisfiedChildStatus('failed')).toBe(false)
    expect(isTerminalChildStatus('escalated')).toBe(true)
    expect(isSatisfiedChildStatus('escalated')).toBe(false)
  })
})
