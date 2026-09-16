import { describe, expect, it } from 'vitest'
import type { ActivityItem } from '../src/components/activity/types'
import { ensureDispatchedRunCard, jobForInvestigation, runDraftFromJob } from '../src/lib/linked-run'
import type { Job } from '../src/types'

function job(partial: Partial<Job> & { id: string }): Job {
  return {
    type: 'job',
    workflowPath: 'workflows/job/workflow.md',
    params: {},
    triggerSource: 'cli',
    status: 'coding',
    phase: 'coding',
    currentWorkItem: null,
    workItems: [],
    workItemLoopCount: 0,
    prMappings: [],
    interactive: true,
    artifacts: [],
    insights: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as Job
}

describe('jobForInvestigation', () => {
  const linked = job({
    id: 'job-1',
    params: { investigationId: 'inv-1', repo: 'org/svc', serviceName: 'svc' },
  })
  const other = job({
    id: 'job-2',
    params: { investigationId: 'inv-2' },
  })

  it('prefers dispatchedJobId when that job is in the list', () => {
    expect(jobForInvestigation([linked, other], 'inv-1', 'job-2')?.id).toBe('job-2')
  })

  it('falls back to params.investigationId when the stamp is missing', () => {
    expect(jobForInvestigation([linked, other], 'inv-1')?.id).toBe('job-1')
    expect(jobForInvestigation([linked, other], 'inv-missing')).toBeNull()
  })
})

describe('runDraftFromJob', () => {
  it('reads repo, reviewers, and description off job params', () => {
    const draft = runDraftFromJob(job({
      id: 'job-1',
      interactive: false,
      workflowPath: 'workflows/job-deep/workflow.md',
      params: {
        repo: 'org/dashboard-api-go',
        serviceName: 'dashboard-api-go',
        description: 'Wire Keycloak auth through the PE gateway.',
        reviewers: ['alice', 'bob'],
      },
    }))
    expect(draft).toEqual({
      repo: 'org/dashboard-api-go',
      serviceName: 'dashboard-api-go',
      description: 'Wire Keycloak auth through the PE gateway.',
      reviewers: 'alice, bob',
      workflowPath: 'workflows/job-deep/workflow.md',
      interactive: false,
    })
  })
})

describe('ensureDispatchedRunCard', () => {
  const dispatched = job({
    id: 'job-9',
    params: {
      investigationId: 'inv-1',
      repo: 'org/svc',
      serviceName: 'svc',
      description: 'Add rate limiting to the public API.',
    },
  })

  it('is a no-op when the dispatched card is already present', () => {
    const items: ActivityItem[] = [
      {
        kind: 'card',
        id: 'card-1',
        card: {
          type: 'run',
          data: { run: runDraftFromJob(dispatched), state: 'dispatched', jobId: 'job-9' },
        },
      },
    ]
    expect(ensureDispatchedRunCard(items, dispatched)).toBe(items)
  })

  it('upgrades the latest draft card rather than appending a second one', () => {
    const items: ActivityItem[] = [
      { kind: 'message', id: 'm1', role: 'user', text: 'go' },
      {
        kind: 'card',
        id: 'card-draft',
        card: {
          type: 'run',
          data: {
            run: { ...runDraftFromJob(dispatched), description: 'edited locally' },
            state: 'draft',
          },
        },
      },
    ]
    const next = ensureDispatchedRunCard(items, dispatched)
    const cards = next.filter(item => item.kind === 'card')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      id: 'card-draft',
      card: { data: { state: 'dispatched', jobId: 'job-9', run: { description: 'edited locally' } } },
    })
  })

  it('appends a reconstructed card when the snapshot never stored one', () => {
    const items: ActivityItem[] = [
      { kind: 'message', id: 'm1', role: 'user', text: 'go' },
    ]
    const next = ensureDispatchedRunCard(items, dispatched)
    expect(next).toHaveLength(2)
    expect(next[1]).toMatchObject({
      id: 'card-run-job-9',
      kind: 'card',
      card: {
        type: 'run',
        data: {
          state: 'dispatched',
          jobId: 'job-9',
          run: { repo: 'org/svc', serviceName: 'svc' },
        },
      },
    })
  })
})
