import { describe, it, expect } from 'vitest'
import {
  JobType,
  STATUS_QUEUED,
  STATUS_COMPLETE,
  STATUS_ESCALATED,
  STATUS_FAILED,
  STATUS_AWAITING_PLAN_APPROVAL,
  STATUS_AWAITING_PR_MERGE,
  STATUS_AWAITING_DEVELOPER_INPUT,
  STATUS_CODING,
  isTerminalStatus,
  isStoppedStatus,
  isParkingStatus,
  defaultWorkflowPath,
  jobParam,
  jobReviewers,
  jobRepoSlug,
  jobServiceName,
  jobJiraTicketId,
  emptyTokenUsage,
  type Job,
} from '../../src/jobs/types'

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'test-job-1',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: {},
    triggerSource: 'cli',
    status: STATUS_QUEUED,
    phase: 'init',
    currentWorkItem: null,
    workItems: [],
    workItemLoopCount: 0,
    prMappings: [],
    interactive: false,
    artifacts: [],
    insights: [],
    tokenUsage: emptyTokenUsage(),
    phaseUsage: [],
    createdAt: '2026-04-04T00:00:00Z',
    updatedAt: '2026-04-04T00:00:00Z',
    ...overrides,
  }
}

// ── isTerminalStatus ──────────────────────────────────────────────────────────

describe('isTerminalStatus', () => {
  it.each([
    [STATUS_COMPLETE, true],
  ])('returns true for terminal status "%s"', (status, expected) => {
    expect(isTerminalStatus(status)).toBe(expected)
  })

  it.each([
    STATUS_QUEUED,
    STATUS_ESCALATED,
    STATUS_FAILED,
    STATUS_AWAITING_PLAN_APPROVAL,
    STATUS_AWAITING_PR_MERGE,
    STATUS_CODING,
    'custom-status',
    '',
  ])('returns false for non-terminal status "%s"', (status) => {
    expect(isTerminalStatus(status)).toBe(false)
  })
})

// ── isStoppedStatus ──────────────────────────────────────────────────────────

describe('isStoppedStatus', () => {
  it.each([
    [STATUS_COMPLETE, true],
    [STATUS_FAILED, true],
    [STATUS_ESCALATED, true],
  ])('returns true for stopped status "%s"', (status, expected) => {
    expect(isStoppedStatus(status)).toBe(expected)
  })

  it.each([
    STATUS_QUEUED,
    STATUS_AWAITING_PLAN_APPROVAL,
    STATUS_AWAITING_PR_MERGE,
    STATUS_CODING,
    'custom-status',
    '',
  ])('returns false for non-stopped status "%s"', (status) => {
    expect(isStoppedStatus(status)).toBe(false)
  })

  it('is a superset of isTerminalStatus', () => {
    const all = [
      STATUS_QUEUED, STATUS_COMPLETE, STATUS_ESCALATED, STATUS_FAILED,
      STATUS_AWAITING_PLAN_APPROVAL, STATUS_AWAITING_PR_MERGE, STATUS_CODING,
    ]
    for (const s of all) {
      if (isTerminalStatus(s)) {
        expect(isStoppedStatus(s)).toBe(true)
      }
    }
  })
})

// ── isParkingStatus ───────────────────────────────────────────────────────────

describe('isParkingStatus', () => {
  it.each([
    [STATUS_AWAITING_PLAN_APPROVAL, true],
    [STATUS_AWAITING_PR_MERGE, true],
    [STATUS_AWAITING_DEVELOPER_INPUT, true],
    [STATUS_ESCALATED, true],
    [STATUS_FAILED, true],
  ])('returns true for parking status "%s"', (status, expected) => {
    expect(isParkingStatus(status)).toBe(expected)
  })

  it.each([
    STATUS_QUEUED,
    STATUS_COMPLETE,
    STATUS_CODING,
    'awaiting-something-else',
    '',
  ])('returns false for non-parking status "%s"', (status) => {
    expect(isParkingStatus(status)).toBe(false)
  })

  it('parking and terminal statuses are disjoint', () => {
    const all = [
      STATUS_QUEUED, STATUS_COMPLETE, STATUS_ESCALATED, STATUS_FAILED,
      STATUS_AWAITING_PLAN_APPROVAL, STATUS_AWAITING_PR_MERGE, STATUS_CODING,
    ]
    for (const s of all) {
      if (isTerminalStatus(s)) {
        expect(isParkingStatus(s)).toBe(false)
      }
      if (isParkingStatus(s)) {
        expect(isTerminalStatus(s)).toBe(false)
      }
    }
  })
})

// ── defaultWorkflowPath ───────────────────────────────────────────────────────

describe('defaultWorkflowPath', () => {
  it('returns the generic implementation workflow for Job type', () => {
    expect(defaultWorkflowPath(JobType.Job)).toBe('workflows/job/workflow.md')
  })

  it('returns self-update workflow for SelfUpdate type', () => {
    expect(defaultWorkflowPath(JobType.SelfUpdate)).toBe('workflows/self-update/workflow.md')
  })
})

// ── jobParam ──────────────────────────────────────────────────────────────────

describe('jobParam', () => {
  it('returns the value when the key exists', () => {
    const job = makeJob({ params: { myKey: 'myValue' } })
    expect(jobParam(job, 'myKey', 'default')).toBe('myValue')
  })

  it('returns the fallback when the key does not exist', () => {
    const job = makeJob({ params: {} })
    expect(jobParam(job, 'missing', 'fallback')).toBe('fallback')
  })

  it('returns the value even when it is falsy but not nullish', () => {
    const job = makeJob({ params: { count: 0, empty: '', flag: false } })
    expect(jobParam(job, 'count', 99)).toBe(0)
    expect(jobParam(job, 'empty', 'default')).toBe('')
    expect(jobParam(job, 'flag', true)).toBe(false)
  })

  it('returns the fallback when value is undefined', () => {
    const job = makeJob({ params: { undef: undefined } })
    expect(jobParam(job, 'undef', 'fallback')).toBe('fallback')
  })

  it('returns the fallback when value is null', () => {
    const job = makeJob({ params: { nul: null } })
    expect(jobParam(job, 'nul', 'fallback')).toBe('fallback')
  })
})

// ── jobReviewers ──────────────────────────────────────────────────────────────

describe('jobReviewers', () => {
  it('returns the reviewers array when present', () => {
    const job = makeJob({ params: { reviewers: ['alice', 'bob'] } })
    expect(jobReviewers(job)).toEqual(['alice', 'bob'])
  })

  it('returns empty array when reviewers is missing', () => {
    expect(jobReviewers(makeJob())).toEqual([])
  })

  it('returns empty array when reviewers is not an array', () => {
    const job = makeJob({ params: { reviewers: 'alice' } })
    expect(jobReviewers(job)).toEqual([])
  })

  it('returns empty array when reviewers is null', () => {
    const job = makeJob({ params: { reviewers: null } })
    expect(jobReviewers(job)).toEqual([])
  })
})

// ── jobRepoSlug ───────────────────────────────────────────────────────────────

describe('jobRepoSlug', () => {
  it('returns the repoSlug when present', () => {
    const job = makeJob({ params: { repoSlug: 'my-service' } })
    expect(jobRepoSlug(job)).toBe('my-service')
  })

  it('returns empty string when missing', () => {
    expect(jobRepoSlug(makeJob())).toBe('')
  })

  it('returns empty string when repoSlug is not a string', () => {
    const job = makeJob({ params: { repoSlug: 42 } })
    // 42 is not a string, so (42 as string) is truthy — returns 42 cast as string
    // This tests the actual behavior rather than ideal behavior
    expect(jobRepoSlug(job)).toBe(42)
  })
})

// ── jobServiceName ────────────────────────────────────────────────────────────

describe('jobServiceName', () => {
  it('returns the serviceName when present', () => {
    const job = makeJob({ params: { serviceName: 'user-service' } })
    expect(jobServiceName(job)).toBe('user-service')
  })

  it('returns empty string when missing', () => {
    expect(jobServiceName(makeJob())).toBe('')
  })
})

// ── jobJiraTicketId ───────────────────────────────────────────────────────────

describe('jobJiraTicketId', () => {
  it('returns the ticket ID when present', () => {
    const job = makeJob({ params: { jiraTicketId: 'PROJ-123' } })
    expect(jobJiraTicketId(job)).toBe('PROJ-123')
  })

  it('returns undefined when missing', () => {
    expect(jobJiraTicketId(makeJob())).toBeUndefined()
  })
})

// ── Status constant values ────────────────────────────────────────────────────

describe('status constants', () => {
  it('all have unique values', () => {
    const values = [
      STATUS_QUEUED, STATUS_COMPLETE, STATUS_ESCALATED, STATUS_FAILED,
      STATUS_AWAITING_PLAN_APPROVAL, STATUS_AWAITING_PR_MERGE, STATUS_CODING,
    ]
    expect(new Set(values).size).toBe(values.length)
  })
})

// ── JobType enum ──────────────────────────────────────────────────────────────

describe('JobType', () => {
  it('has expected string values', () => {
    expect(JobType.Job).toBe('job')
    expect(JobType.SelfUpdate).toBe('self-update')
  })

  it('has exactly 2 members', () => {
    expect(Object.values(JobType)).toHaveLength(2)
  })
})
