// Shape of the oss-contribution child job.
//
// The retrospective no longer writes upstream file bodies; it dispatches
// this job with one or more findings. The briefing is assembled here so
// every child sees the same sections, and so a multi-finding call cannot
// drop an item the analyst listed.

import { describe, expect, it } from 'vitest'
import {
  buildContributionBriefing,
  buildOssContributionJobInput,
  contributionJobTitle,
  contributionTierFor,
  isOssContributionCategory,
  isOssContributionJob,
  type OssContributionFinding,
} from '../../src/jobs/oss-contribution'

const CODE: OssContributionFinding = {
  id: 'finding-3',
  category: 'runner-code',
  issueNumber: 42,
  issueUrl: 'https://github.com/o/r/issues/42',
  title: 'Phase retry loses the corrective prompt',
  description: 'The corrective prompt is dropped on retry.',
}

const INTEL: OssContributionFinding = {
  id: 'finding-1',
  category: 'base-intelligence',
  issueNumber: 46,
  issueUrl: 'https://github.com/o/r/issues/46',
  title: 'Spec writer skips tracker comments',
  description: 'agents/spec-writer.md only calls tracker_get_issue.',
}

describe('buildOssContributionJobInput', () => {
  it('aims the clone at the fork and the PR at upstream', () => {
    const input = buildOssContributionJobInput({
      upstreamSlug: 'coro-ai-framework/coro',
      forkSlug: 'contributor/coro',
      forkOwner: 'contributor',
      baseBranch: 'main',
      retrospectiveJobId: 'retro-1',
      findings: [CODE],
    })

    expect(input).toMatchObject({
      type: 'job',
      workflowPath: 'workflows/oss-contribution/workflow.md',
      triggerSource: 'internal',
    })
    expect(input.params).toMatchObject({
      repo: 'contributor/coro',
      repoSlug: 'contributor/coro',
      upstreamRepo: 'coro-ai-framework/coro',
      prSourceOwner: 'contributor',
      prTargetBranch: 'main',
      title: CODE.title,
      upstreamIssueNumber: 42,
      upstreamIssueUrl: CODE.issueUrl,
      retrospectiveJobId: 'retro-1',
      retrospectiveFindingId: 'finding-3',
      findings: [CODE],
      epicAllowed: false,
      reviewers: [],
    })
    expect(input.params.interactive).toBe(true)
    expect(input.params.description).toContain(CODE.description)
  })

  it('keeps every finding in params and titles the job from the first', () => {
    const input = buildOssContributionJobInput({
      upstreamSlug: 'coro-ai-framework/coro',
      forkSlug: 'contributor/coro',
      forkOwner: 'contributor',
      baseBranch: 'main',
      retrospectiveJobId: 'retro-1',
      findings: [INTEL, CODE],
    })

    expect(input.params.title).toBe('Spec writer skips tracker comments (+1 more)')
    expect(input.params.findings).toEqual([INTEL, CODE])
    expect(input.params.description).toContain('finding-1')
    expect(input.params.description).toContain('finding-3')
  })

  it('refuses to build a job with no findings', () => {
    expect(() => buildOssContributionJobInput({
      upstreamSlug: 'coro-ai-framework/coro',
      forkSlug: 'contributor/coro',
      forkOwner: 'contributor',
      baseBranch: 'main',
      retrospectiveJobId: 'retro-1',
      findings: [],
    })).toThrow(/at least one finding/)
  })
})

describe('buildContributionBriefing', () => {
  it('tells the planner to keep one PR and defer — not escalate — what does not couple', () => {
    const briefing = buildContributionBriefing([INTEL, CODE])
    expect(briefing).toContain('One reviewable PR')
    expect(briefing).toContain('Do not open a stack of PRs')
    // Escalating a leftover ends the job and loses the coupled set's PR.
    expect(briefing).toContain('do not `escalate` a leftover')
    expect(briefing).toContain('## 1. finding-1 — Spec writer skips tracker comments')
    expect(briefing).toContain('Category: base-intelligence')
    expect(briefing).toContain('Issue: https://github.com/o/r/issues/46 (#46)')
    expect(briefing).toContain(INTEL.description)
    expect(briefing).toContain('## 2. finding-3 —')
  })

  it('renders a structured briefing and evidence pack when present', () => {
    const withBriefing: OssContributionFinding = {
      ...CODE,
      briefing: {
        behaviourNow: 'Retry drops the corrective prompt.',
        behaviourWanted: 'Retry reapplies the last developer message.',
        evidence: 'coding reworkRuns 4 vs 1 on two jobs',
        targetPaths: ['packages/runner/src/jobs/runner.ts'],
        verified: true,
        failingTest: 'tests/runner/runner.test.ts',
        predictedMetric: { name: 'coding.reworkRuns', direction: 'decrease', baseline: 4 },
      },
      evidencePack: {
        antiPatterns: ['session-reset'],
        toolFailures: [{ toolName: 'Bash', errorClass: 'EPERM', count: 6 }],
      },
    }
    const text = buildContributionBriefing([withBriefing])
    expect(text).toContain('Today: Retry drops the corrective prompt.')
    expect(text).toContain('Failing test: tests/runner/runner.test.ts')
    expect(text).toContain('Predicted metric: coding.reworkRuns should decrease, baseline 4')
    expect(text).toContain('anti-patterns: session-reset')
    expect(text).toContain('tool failure: Bash EPERM ×6')
    expect(text).not.toContain(CODE.description)
  })
})

describe('contribution helpers', () => {
  it('maps categories onto the destination that permits them', () => {
    expect(contributionTierFor('base-intelligence')).toBe('upstreamIntelligence')
    expect(contributionTierFor('runner-code')).toBe('upstreamCode')
    expect(isOssContributionCategory('base-intelligence')).toBe(true)
    expect(isOssContributionCategory('tenant-intelligence')).toBe(false)
  })

  it('titles a single finding as itself', () => {
    expect(contributionJobTitle([CODE])).toBe(CODE.title)
  })

  it('matches the workflow path even when the job is otherwise empty', () => {
    expect(isOssContributionJob({ workflowPath: 'workflows/oss-contribution/workflow.md' })).toBe(true)
    expect(isOssContributionJob({ workflowPath: 'workflows/job/workflow.md' })).toBe(false)
  })
})
