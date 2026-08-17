import { describe, it, expect } from 'vitest'
import { JobType, RETROSPECTIVE_WORKFLOW_PATH, type Job } from '@coro-ai/cloud-protocol'
import {
  assertRetrospectiveTiersAvailable,
  buildRetrospectiveJobInput,
  findActiveRetrospective,
  normalizeRetrospectiveTiers,
  RETROSPECTIVE_DEFAULT_WINDOW,
  RETROSPECTIVE_MAX_WINDOW,
  RETROSPECTIVE_MIN_WINDOW,
  retrospectiveFindings,
  summarizeRetrospective,
  type RetrospectiveTiers,
} from '../../src/jobs/retrospective'
import { makeMockJob } from '../mcp/fixtures'

function retroJob(over: Record<string, unknown> = {}): Job {
  return makeMockJob({
    id: 'coro-retrospective-1',
    type: JobType.Retrospective,
    workflowPath: RETROSPECTIVE_WORKFLOW_PATH,
    status: 'complete',
    phase: 'shipping',
    params: { jobWindow: 25, tiers: { tenant: true, upstreamIntelligence: false, upstreamCode: false } },
    ...over,
  }) as unknown as Job
}

function artifact(kind: string, data: Record<string, unknown>) {
  return {
    id: `art-${kind}`,
    phase: 'analysis',
    kind,
    title: kind,
    data,
    createdBy: 'analysis',
    createdAt: '2026-01-01T00:00:00Z',
  }
}

describe('buildRetrospectiveJobInput', () => {
  it('always forces interactive so the approval checkpoint actually parks', () => {
    // The runner only honours `interactive_checkpoint` when job.interactive
    // is true, so this is a correctness property, not a preference.
    expect(buildRetrospectiveJobInput().params['interactive']).toBe(true)
  })

  it('produces a retrospective job on the canonical workflow path', () => {
    const input = buildRetrospectiveJobInput()
    expect(input.type).toBe('retrospective')
    expect(input.workflowPath).toBe(RETROSPECTIVE_WORKFLOW_PATH)
    expect(input.triggerSource).toBe('internal')
    expect(input.params['serviceName']).toBe('coro')
  })

  it('defaults the window and the tiers conservatively', () => {
    const params = buildRetrospectiveJobInput().params
    expect(params['jobWindow']).toBe(RETROSPECTIVE_DEFAULT_WINDOW)
    expect(params['tiers']).toEqual({ tenant: true, upstreamIntelligence: false, upstreamCode: false })
  })

  it('clamps the window into range and ignores nonsense', () => {
    expect(buildRetrospectiveJobInput({ jobWindow: 1 }).params['jobWindow']).toBe(RETROSPECTIVE_MIN_WINDOW)
    expect(buildRetrospectiveJobInput({ jobWindow: 9999 }).params['jobWindow']).toBe(RETROSPECTIVE_MAX_WINDOW)
    expect(buildRetrospectiveJobInput({ jobWindow: 30.7 }).params['jobWindow']).toBe(30)
    expect(buildRetrospectiveJobInput({ jobWindow: Number.NaN }).params['jobWindow'])
      .toBe(RETROSPECTIVE_DEFAULT_WINDOW)
  })

  it('fills in unspecified tiers rather than dropping them', () => {
    const params = buildRetrospectiveJobInput({ tiers: { upstreamCode: true } }).params
    expect(params['tiers']).toEqual({ tenant: true, upstreamIntelligence: false, upstreamCode: true })
  })
})

describe('assertRetrospectiveTiersAvailable', () => {
  const tiers = (over: Partial<RetrospectiveTiers> = {}) => normalizeRetrospectiveTiers(over)

  it('refuses an upstream destination the install cannot reach', () => {
    expect(() => assertRetrospectiveTiersAvailable(tiers({ upstreamIntelligence: true }), false))
      .toThrow(/upstream\.repoUrl/)
    expect(() => assertRetrospectiveTiersAvailable(tiers({ upstreamCode: true }), false))
      .toThrow(/upstream\.repoUrl/)
  })

  it('allows a tenant-only run on an install with no upstream', () => {
    expect(() => assertRetrospectiveTiersAvailable(tiers(), false)).not.toThrow()
  })

  it('allows upstream destinations once one is configured', () => {
    expect(() => assertRetrospectiveTiersAvailable(
      tiers({ upstreamIntelligence: true, upstreamCode: true }),
      true,
    )).not.toThrow()
  })
})

describe('findActiveRetrospective', () => {
  it('finds a retrospective that has not stopped', () => {
    const jobs = [
      retroJob({ id: 'retro-done', status: 'complete' }),
      retroJob({ id: 'retro-live', status: 'analyzing' }),
    ]
    expect(findActiveRetrospective(jobs)?.id).toBe('retro-live')
  })

  it('treats a parked retrospective as active — it is still mid-run', () => {
    const jobs = [retroJob({ id: 'retro-parked', status: 'awaiting-developer-input' })]
    expect(findActiveRetrospective(jobs)?.id).toBe('retro-parked')
  })

  it('ignores stopped retrospectives and every other job type', () => {
    const jobs = [
      retroJob({ id: 'retro-a', status: 'complete' }),
      retroJob({ id: 'retro-b', status: 'escalated' }),
      retroJob({ id: 'retro-c', status: 'cancelled' }),
      makeMockJob({ id: 'job-live', type: JobType.Job, status: 'coding' }) as unknown as Job,
    ]
    expect(findActiveRetrospective(jobs)).toBeUndefined()
  })
})

describe('summarizeRetrospective', () => {
  const withReport = retroJob({
    artifacts: [
      artifact('retrospective-report', {
        findings: [
          {
            id: 'finding-1',
            title: 'Coder loops on Go test scaffolding',
            category: 'base-intelligence',
            severity: 'high',
            evidence: [
              { jobId: 'job-a', detail: 'coding ran 5 times', metrics: { phaseRuns: 5 } },
              { jobId: 'job-b', detail: 'coding ran 4 times' },
            ],
            proposedRemedy: 'Extend golang-conventions',
            targetPaths: ['.claude/skills/golang-conventions/SKILL.md'],
            predictedMetric: { name: 'coding.reworkRuns', direction: 'decrease', baseline: 4 },
            verification: 'verified',
            counterEvidence: [{ jobId: 'job-c', detail: 'one clean Go job in the window' }],
          },
        ],
      }),
      artifact('retrospective-outcome', {
        outcomes: [{ findingId: 'finding-1', destination: 'tenant', prUrl: 'https://git/pr/1' }],
      }),
    ],
  })

  it('parses findings and outcomes out of the artefacts', () => {
    const summary = summarizeRetrospective(withReport)

    expect(summary.findings).toHaveLength(1)
    expect(summary.findings[0]).toMatchObject({
      id: 'finding-1',
      category: 'base-intelligence',
      severity: 'high',
      proposedRemedy: 'Extend golang-conventions',
      predictedMetric: { name: 'coding.reworkRuns', direction: 'decrease', baseline: 4 },
      verification: 'verified',
    })
    expect(summary.findings[0].counterEvidence).toEqual([
      { jobId: 'job-c', detail: 'one clean Go job in the window' },
    ])
    expect(summary.findings[0].evidence).toHaveLength(2)
    expect(summary.outcomes[0]).toEqual({
      findingId: 'finding-1', destination: 'tenant', prUrl: 'https://git/pr/1',
    })
  })

  it('prefers the newest artefact when a phase re-ran', () => {
    const rerun = retroJob({
      artifacts: [
        artifact('retrospective-report', { findings: [{ id: 'finding-1', title: 'first pass' }] }),
        artifact('retrospective-report', { findings: [{ id: 'finding-1', title: 'second pass' }] }),
      ],
    })
    expect(retrospectiveFindings(rerun)[0].title).toBe('second pass')
  })

  it('flags a job parked on the approval gate', () => {
    const parked = retroJob({
      status: 'awaiting-developer-input',
      phase: 'analysis',
      awaitingNextPhase: 'shipping',
    })
    expect(summarizeRetrospective(parked).awaitingApproval).toBe(true)
    expect(summarizeRetrospective(withReport).awaitingApproval).toBe(false)
  })

  it('flags the gate by the park, not by the phase name', () => {
    // An overlay may rename `analysis`; a boundary park on a retrospective
    // is the gate regardless, since the workflow declares one checkpoint.
    const renamed = retroJob({
      status: 'awaiting-developer-input',
      phase: 'review-findings',
      awaitingNextPhase: 'shipping',
    })
    expect(summarizeRetrospective(renamed).awaitingApproval).toBe(true)

    // Mid-phase question: parked, but not at a boundary — no ballot.
    const midPhase = retroJob({ status: 'awaiting-developer-input', phase: 'analysis' })
    expect(summarizeRetrospective(midPhase).awaitingApproval).toBe(false)
  })

  it('survives a model-authored artefact that is malformed', () => {
    const messy = retroJob({
      artifacts: [
        artifact('retrospective-report', {
          findings: [
            'not an object',
            { title: 'no id' },
            { id: 'finding-2', title: 'valid', category: 'invented-category', severity: 'catastrophic' },
            { id: 'finding-3', title: 'bad evidence', evidence: ['nope', { detail: 'no jobId' }] },
          ],
        }),
        artifact('retrospective-outcome', { outcomes: 'not an array' }),
      ],
    })

    const summary = summarizeRetrospective(messy)
    expect(summary.findings.map(f => f.id)).toEqual(['finding-2', 'finding-3'])
    // Unrecognised enum values fall back rather than propagating garbage.
    expect(summary.findings[0].category).toBe('base-intelligence')
    expect(summary.findings[0].severity).toBe('medium')
    expect(summary.findings[1].evidence).toEqual([])
    expect(summary.outcomes).toEqual([])
  })

  it('returns empty findings for a run that has not reported yet', () => {
    const summary = summarizeRetrospective(retroJob({ artifacts: [], status: 'analyzing', phase: 'analysis' }))
    expect(summary.findings).toEqual([])
    expect(summary.outcomes).toEqual([])
    expect(summary.jobWindow).toBe(25)
    expect(summary.tiers.tenant).toBe(true)
  })
})
