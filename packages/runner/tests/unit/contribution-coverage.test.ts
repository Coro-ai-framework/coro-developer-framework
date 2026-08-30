// ── contribution-coverage.test.ts ───────────────────────────────────────────
//
// Lockdown tests for `src/jobs/contribution-coverage.ts`. The regression
// behind it: a contribution job dispatched with four findings shipped the two
// that coupled, wrote the other two into its plan, and reported `complete` —
// leaving two open upstream issues no job owned.
//
// The runner.ts integration (STATUS_ESCALATED at the completion boundary) is
// covered by `tests/runner/runner.test.ts`; this file pins the derivation and
// the message shape.

import { describe, it, expect } from 'vitest'
import {
  buildContributionCoverageMessage,
  evaluateContributionCoverage,
  uncoveredIssueNumbers,
} from '../../src/jobs/contribution-coverage'
import {
  JobType,
  OSS_CONTRIBUTION_WORKFLOW_PATH,
  type Artifact,
  type Job,
} from '@coro-ai/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'contrib-job-1',
    type: JobType.Job,
    workflowPath: OSS_CONTRIBUTION_WORKFLOW_PATH,
    params: {},
    triggerSource: 'internal',
    status: 'running',
    phase: 'contribution',
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

function prLink(data: Record<string, unknown>): Artifact {
  return {
    id: 'art-1',
    phase: 'contribution',
    kind: 'pr-link',
    title: 'Upstream PR',
    data,
    createdBy: 'agent',
    createdAt: '2026-01-01T00:00:00Z',
  }
}

const FINDINGS = [
  { id: 'finding-1', issueNumber: 55, title: 'Runner advances review too early' },
  { id: 'finding-2', issueNumber: 56, title: 'Parks counted as rework' },
  { id: 'finding-3', issueNumber: 57, title: 'Coder branches off main' },
  { id: 'finding-4', issueNumber: 58, title: 'Go sandbox recipe rediscovered' },
]

describe('evaluateContributionCoverage — applicability', () => {
  it('skips any workflow but oss-contribution, so ordinary jobs are untouched', () => {
    const job = makeJob({
      workflowPath: 'workflows/job/workflow.md',
      params: { findings: FINDINGS },
    })
    expect(evaluateContributionCoverage(job)).toBeNull()
  })

  it('skips a contribution job carrying no findings — an absent contract, not a breach', () => {
    expect(evaluateContributionCoverage(makeJob({ params: {} }))).toBeNull()
  })
})

describe('evaluateContributionCoverage — derivation', () => {
  it('reports the findings no PR claims (the four-dispatched, two-shipped case)', () => {
    const job = makeJob({
      params: { findings: FINDINGS },
      artifacts: [prLink({
        url: 'https://github.com/o/r/pull/59',
        findingIds: ['finding-1', 'finding-2'],
      })],
    })

    const decision = evaluateContributionCoverage(job)!
    expect(decision.implemented.map(f => f.id)).toEqual(['finding-1', 'finding-2'])
    expect(decision.uncovered.map(f => f.id)).toEqual(['finding-3', 'finding-4'])
    expect(decision.prUrls).toEqual(['https://github.com/o/r/pull/59'])
    expect(uncoveredIssueNumbers(decision)).toEqual([57, 58])
  })

  it('reports full coverage when every dispatched finding is claimed', () => {
    const job = makeJob({
      params: { findings: FINDINGS },
      artifacts: [prLink({
        url: 'https://github.com/o/r/pull/59',
        findingIds: ['finding-1', 'finding-2', 'finding-3', 'finding-4'],
      })],
    })
    expect(evaluateContributionCoverage(job)!.uncovered).toEqual([])
  })

  it('unions claims across several pr-link artefacts', () => {
    const job = makeJob({
      params: { findings: FINDINGS.slice(0, 2) },
      artifacts: [
        prLink({ url: 'https://github.com/o/r/pull/59', findingIds: ['finding-1'] }),
        prLink({ url: 'https://github.com/o/r/pull/60', findingIds: ['finding-2'] }),
      ],
    })
    const decision = evaluateContributionCoverage(job)!
    expect(decision.uncovered).toEqual([])
    expect(decision.prUrls).toHaveLength(2)
  })

  it('treats every finding as uncovered when the job opened no PR at all', () => {
    const job = makeJob({ params: { findings: FINDINGS } })
    const decision = evaluateContributionCoverage(job)!
    expect(decision.uncovered).toHaveLength(4)
    expect(decision.prUrls).toEqual([])
  })

  it('falls back to the issue number when findingIds is absent', () => {
    // The single-finding case: the contributor copies `issueUrl` from params
    // and may not bother with `findingIds`. The issue identifies the finding
    // just as well, and escalating a job that shipped its only finding would
    // be a false alarm.
    const job = makeJob({
      params: { findings: [FINDINGS[0]] },
      artifacts: [prLink({
        url: 'https://github.com/o/r/pull/59',
        issueUrl: 'https://github.com/o/r/issues/55',
      })],
    })
    expect(evaluateContributionCoverage(job)!.uncovered).toEqual([])
  })

  it('accepts a comma-separated string, since an agent writes this field from a template', () => {
    const job = makeJob({
      params: { findings: FINDINGS.slice(0, 3) },
      artifacts: [prLink({ findingIds: 'finding-1, finding-2' })],
    })
    expect(evaluateContributionCoverage(job)!.uncovered.map(f => f.id)).toEqual(['finding-3'])
  })

  it('discards an unsubstituted placeholder rather than reading it as an id', () => {
    const job = makeJob({
      params: { findings: FINDINGS.slice(0, 2) },
      artifacts: [prLink({ findingIds: '<ids from params.findings that this PR implements>' })],
    })
    expect(evaluateContributionCoverage(job)!.uncovered).toHaveLength(2)
  })

  it('ignores retrospectiveFindingId, which echoes params rather than claiming a fix', () => {
    // Dispatch mirrors the *first* finding into this param whether or not the
    // PR implements it. Crediting it would hide exactly the case that matters.
    const job = makeJob({
      params: { findings: FINDINGS.slice(0, 2) },
      artifacts: [prLink({
        url: 'https://github.com/o/r/pull/59',
        retrospectiveFindingId: 'finding-1',
        findingIds: ['finding-2'],
      })],
    })
    expect(evaluateContributionCoverage(job)!.uncovered.map(f => f.id)).toEqual(['finding-1'])
  })

  it('survives findings that lost their fields in transit', () => {
    const job = makeJob({
      params: { findings: [{ id: 'finding-1' }, { title: 'no id' }, null, 'nonsense'] },
      artifacts: [],
    })
    const decision = evaluateContributionCoverage(job)!
    expect(decision.uncovered.map(f => f.id)).toEqual(['finding-1'])
    expect(uncoveredIssueNumbers(decision)).toEqual([])
  })
})

describe('buildContributionCoverageMessage', () => {
  it('leads with what shipped, then names the issues still needing a job', () => {
    const job = makeJob({
      params: { findings: FINDINGS },
      artifacts: [prLink({
        url: 'https://github.com/o/r/pull/59',
        findingIds: ['finding-1', 'finding-2'],
      })],
    })
    const message = buildContributionCoverageMessage(evaluateContributionCoverage(job)!)

    expect(message).toContain('2 of 4 dispatched findings')
    expect(message).toContain('https://github.com/o/r/pull/59')
    expect(message).toContain('finding-3 (#57) — Coder branches off main')
    expect(message).toContain('finding-4 (#58) — Go sandbox recipe rediscovered')
    // The scope decision is not the defect being reported.
    expect(message).toContain('may well have been correct')
    expect(message).toContain('implementation plan')
  })
})
