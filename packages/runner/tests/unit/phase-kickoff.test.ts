import { describe, it, expect } from 'vitest'
import {
  buildPhaseKickoffMessage,
  buildOpenPrsKickoffBlock,
  buildCheckpointApprovalBlock,
  buildCodingPreflightWarning,
  formatRelativeAge,
} from '../../src/jobs/phase-kickoff'
import { JobType, type Job } from '@coro-ai/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'

const NOW = Date.parse('2026-05-21T12:00:00Z')

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'kickoff-job',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: {},
    triggerSource: 'cli',
    status: 'running',
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
    ...overrides,
  }
}

describe('formatRelativeAge', () => {
  it('formats hours ago', () => {
    expect(formatRelativeAge('2026-05-21T07:00:00Z', NOW)).toBe('5h ago')
  })
})

describe('buildOpenPrsKickoffBlock', () => {
  it('renders open and recently merged PRs', () => {
    const block = buildOpenPrsKickoffBlock(makeJob({
      prMappings: [
        { prId: 7, workItem: 'wi-1', repoSlug: 'r', openedAt: '2026-05-21T07:00:00Z' },
        { prId: 8, workItem: 'wi-1', repoSlug: 'r', openedAt: '2026-05-21T08:00:00Z' },
        { prId: 5, workItem: 'wi-0', repoSlug: 'r', openedAt: '2026-05-20T00:00:00Z', mergedAt: '2026-05-21T06:00:00Z' },
      ],
    }), NOW)

    expect(block).toContain('## Open PRs on this job')
    expect(block).toContain('| #7 | wi-1 |')
    expect(block).toContain('| #8 | wi-1 |')
    expect(block).not.toContain('| #5 |')
    expect(block).toContain('Recently merged')
    expect(block).toContain('PR #5 (wi-0)')
  })

  it('returns empty string when there are no mappings', () => {
    expect(buildOpenPrsKickoffBlock(makeJob())).toBe('')
  })
})

describe('buildCodingPreflightWarning', () => {
  it('warns when current work item has open PRs', () => {
    const warn = buildCodingPreflightWarning(makeJob({
      phase: 'coding',
      currentWorkItem: 'wi-1',
      prMappings: [
        { prId: 7, workItem: 'wi-1', repoSlug: 'r', openedAt: '2026-01-01' },
        { prId: 9, workItem: 'wi-2', repoSlug: 'r', openedAt: '2026-01-02' },
      ],
    }))
    expect(warn).toContain('[coding-preflight]')
    expect(warn).toContain('wi-1')
    expect(warn).toContain('#7')
    expect(warn).not.toContain('#9')
    expect(warn).toContain('end your turn')
    expect(warn).toContain('review/gatekeeper')
  })

  it('names the workflow-specific review phase when declaredPhases is provided', () => {
    const warn = buildCodingPreflightWarning(makeJob({
      phase: 'coding',
      currentWorkItem: 'wi-1',
      prMappings: [
        { prId: 7, workItem: 'wi-1', repoSlug: 'r', openedAt: '2026-01-01' },
      ],
    }), ['planning', 'coding', 'review-and-verify'])
    expect(warn).toContain('`review-and-verify`')
    expect(warn).not.toContain('goto_phase("review")')
  })

  it('is absent outside coding or without currentWorkItem', () => {
    expect(buildCodingPreflightWarning(makeJob({ phase: 'review', currentWorkItem: 'wi-1' }))).toBe('')
    expect(buildCodingPreflightWarning(makeJob({ phase: 'coding', currentWorkItem: null }))).toBe('')
  })
})

describe('buildPhaseKickoffMessage', () => {
  const JOB_DIR = '/tmp/work/kickoff-job'

  it('includes preflight and open PR block in coding phase', () => {
    const msg = buildPhaseKickoffMessage(makeJob({
      phase: 'coding',
      currentWorkItem: 'wi-1',
      prMappings: [
        { prId: 7, workItem: 'wi-1', repoSlug: 'r', openedAt: '2026-05-21T07:00:00Z' },
      ],
    }), JOB_DIR, NOW)

    expect(msg).toContain('[coding-preflight]')
    expect(msg).toContain('## Open PRs on this job')
    expect(msg).toContain('Begin phase **coding**')
  })

  it('leads with the approval the developer gave to reach this phase', () => {
    const msg = buildPhaseKickoffMessage(makeJob({
      phase: 'shipping',
      checkpointApproval: {
        fromPhase: 'analysis',
        forPhase: 'shipping',
        message: 'Approved findings: finding-1\nSkipped findings: finding-2',
        at: '2026-05-21T11:00:00Z',
      },
    }), JOB_DIR, NOW)

    expect(msg).toContain('[DEVELOPER APPROVAL]')
    expect(msg).toContain('Approved findings: finding-1')
    expect(msg).toContain('`analysis`')
    expect(msg.indexOf('[DEVELOPER APPROVAL]')).toBeLessThan(msg.indexOf('Begin phase'))
  })

  it('includes workspace block when repo checkout params are set', () => {
    const msg = buildPhaseKickoffMessage(makeJob({
      params: {
        repoCheckoutDir: 'my-service',
        repoCheckoutAbsDir: '/tmp/work/kickoff-job/my-service',
      },
    }), JOB_DIR, NOW)

    expect(msg).toContain('## Workspace')
    expect(msg).toContain('cd my-service &&')
    expect(msg).toContain('{language}-conventions')
    expect(msg).not.toContain('go build')
  })
})

describe('buildCheckpointApprovalBlock', () => {
  const approval = {
    fromPhase: 'analysis',
    forPhase: 'shipping',
    message: 'Approved findings: finding-1',
    at: '2026-05-21T11:00:00Z',
  }

  it('is empty for a phase the approval was not addressed to', () => {
    // The departing phase already read the reply in its resume prompt, and a
    // third phase was never part of the decision.
    expect(buildCheckpointApprovalBlock(makeJob({ phase: 'analysis', checkpointApproval: approval }))).toBe('')
    expect(buildCheckpointApprovalBlock(makeJob({ phase: 'review', checkpointApproval: approval }))).toBe('')
  })

  it('is empty when no approval is carried', () => {
    expect(buildCheckpointApprovalBlock(makeJob({ phase: 'shipping' }))).toBe('')
  })

  it('renders for the phase the approval released', () => {
    const block = buildCheckpointApprovalBlock(makeJob({ phase: 'shipping', checkpointApproval: approval }))
    expect(block).toContain('[DEVELOPER APPROVAL]')
    expect(block).toContain('"Approved findings: finding-1"')
  })
})
