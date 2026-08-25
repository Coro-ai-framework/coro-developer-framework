import { describe, expect, it } from 'vitest'
import { detectOverlaps, validateRetrospectiveReport } from '../../src/tools/retrospective-report'

/** A finding that passes every check, so a test varies exactly one thing. */
function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'finding-1',
    title: 'Coder loops on Go test scaffolding',
    category: 'base-intelligence',
    severity: 'high',
    evidence: [
      { jobId: 'job-a', detail: 'coding reworked 3 times' },
      { jobId: 'job-b', detail: 'coding reworked 2 times' },
    ],
    targetPaths: ['packages/intelligence-base/layer/agents/coder.md'],
    predictedMetric: { name: 'coding.reworkRuns', direction: 'decrease', baseline: 5 },
    ...over,
  }
}

function report(findings: Array<Record<string, unknown>>): Record<string, unknown> {
  return { path: 'retrospective-report.md', findings }
}

describe('validateRetrospectiveReport', () => {
  it('accepts a clean report, and an empty window', () => {
    expect(validateRetrospectiveReport(report([finding()]))).toEqual([])
    expect(validateRetrospectiveReport(report([]))).toEqual([])
  })

  it('requires a findings array at all', () => {
    expect(validateRetrospectiveReport({ path: 'x.md' })[0]).toMatch(/must carry a `findings` array/)
    expect(validateRetrospectiveReport({ findings: 'none' })[0]).toMatch(/must be an array/)
  })

  it('names findings that would be silently dropped', () => {
    const problems = validateRetrospectiveReport(report([
      finding({ id: '' }),
      finding({ id: 'finding-2', title: '' }),
    ]))
    expect(problems.some(p => /findings\[0\] has no `id`/.test(p))).toBe(true)
    expect(problems.some(p => /"finding-2" has no `title`/.test(p))).toBe(true)
  })

  it('rejects duplicate ids, because the ballot addresses findings by id', () => {
    const problems = validateRetrospectiveReport(report([
      finding({ id: 'finding-1', targetPaths: ['a.md'] }),
      finding({ id: 'finding-1', targetPaths: ['b.md'] }),
    ]))
    expect(problems.some(p => /share the id "finding-1"/.test(p))).toBe(true)
  })

  it('rejects a category that would otherwise default silently', () => {
    const problems = validateRetrospectiveReport(report([finding({ category: 'runner_code' })]))
    expect(problems[0]).toMatch(/has category "runner_code"/)
  })

  describe('the two-job bar', () => {
    it('rejects a single-job finding below high severity', () => {
      const problems = validateRetrospectiveReport(report([finding({
        severity: 'medium',
        evidence: [{ jobId: 'job-a', detail: 'once' }],
      })]))
      expect(problems[0]).toMatch(/cites one job/)
    })

    it('allows one job for a high-severity evidence-pipeline defect', () => {
      expect(validateRetrospectiveReport(report([finding({
        severity: 'high',
        evidence: [{ jobId: 'job-a', detail: 'cluster schema is wrong' }],
      })]))).toEqual([])
    })

    it('rejects a finding with no evidence at all', () => {
      const problems = validateRetrospectiveReport(report([finding({ evidence: [] })]))
      expect(problems[0]).toMatch(/cites no job/)
    })
  })

  describe('predicted metrics', () => {
    it('requires one', () => {
      const problems = validateRetrospectiveReport(report([finding({ predictedMetric: undefined })]))
      expect(problems[0]).toMatch(/has no `predictedMetric`/)
      expect(problems[0]).toMatch(/insight:<category>/)
    })

    it('rejects the invented names from the 2026-08-25 run', () => {
      for (const name of [
        'tracker.failureFallbackInsights',
        'scmClone.pathMismatchInsights',
        'portSpec.authAmbiguityRoundTrips',
      ]) {
        const problems = validateRetrospectiveReport(report([finding({
          predictedMetric: { name, direction: 'decrease', baseline: 4 },
        })]))
        expect(problems[0]).toMatch(/the scorer cannot compute/)
      }
    })

    it('accepts a cluster-derived name', () => {
      expect(validateRetrospectiveReport(report([finding({
        predictedMetric: { name: 'insight:auth-friction', direction: 'decrease', baseline: 4 },
      })]))).toEqual([])
    })
  })
})

// The report that motivated this gate: 10-job window, five findings, two of
// which are the same defect written twice.
const REAL_RUN = [
  {
    id: 'finding-1',
    category: 'base-intelligence',
    evidenceJobIds: ['job-623410295', 'job-621605989', 'job-530278716', 'job-528131961'],
    targetPaths: ['agents/spec-writer.md', 'agents/campaign-planner.md'],
  },
  {
    id: 'finding-2',
    category: 'base-intelligence',
    evidenceJobIds: ['job-623410295', 'job-621605989', 'job-530278716'],
    targetPaths: ['.claude/CLAUDE.md', 'snippets/github-clone.md'],
  },
  {
    id: 'finding-3',
    category: 'runner-code',
    evidenceJobIds: ['job-621605989', 'job-565183512'],
    targetPaths: ['packages/runner/src/mcp-handlers.ts'],
  },
  {
    id: 'finding-4',
    category: 'base-intelligence',
    evidenceJobIds: ['job-565183512', 'job-303765035'],
    targetPaths: ['agents/spec-writer.md', 'skills/feature-planning/SKILL.md'],
  },
  {
    id: 'finding-5',
    category: 'runner-code',
    evidenceJobIds: ['job-303765035', 'job-040115889', 'job-692432457'],
    targetPaths: ['packages/runner/src/mcp-handlers.ts', 'packages/runner/src/clients/git-auth.ts'],
  },
]

describe('detectOverlaps', () => {
  it('finds both split modes in the real run, and nothing else', () => {
    const pairs = detectOverlaps(REAL_RUN).map(overlap => `${overlap.a}+${overlap.b}`)
    expect(pairs.sort()).toEqual([
      'finding-1+finding-2', // symptom split: same jobs, different files
      'finding-1+finding-4', // delivery coupling: both edit spec-writer.md
      'finding-3+finding-5', // site split: same file, no shared job
    ])
  })

  it('explains each pair in the terms that flagged it', () => {
    const byPair = new Map(detectOverlaps(REAL_RUN).map(o => [`${o.a}+${o.b}`, o.reason]))
    expect(byPair.get('finding-1+finding-2')).toMatch(/75% of their cited jobs/)
    expect(byPair.get('finding-3+finding-5')).toMatch(/both change packages\/runner\/src\/mcp-handlers\.ts/)
  })

  it('ignores coincidental single-job overlap across categories', () => {
    // finding-3 and finding-4 share job-565183512 but sit in different layers.
    const pairs = detectOverlaps(REAL_RUN).map(o => `${o.a}+${o.b}`)
    expect(pairs).not.toContain('finding-3+finding-4')
    expect(pairs).not.toContain('finding-4+finding-5')
  })
})

describe('overlap resolution', () => {
  const overlapping = [
    finding({
      id: 'finding-3',
      category: 'runner-code',
      evidence: [{ jobId: 'job-a', detail: 'nested clone dir' }, { jobId: 'job-b', detail: 'again' }],
      targetPaths: ['packages/runner/src/mcp-handlers.ts'],
      predictedMetric: { name: 'toolFail:scm_clone_repo', direction: 'decrease', baseline: 5 },
    }),
    finding({
      id: 'finding-5',
      category: 'runner-code',
      evidence: [{ jobId: 'job-c', detail: 'sandbox blocks .git' }, { jobId: 'job-d', detail: 'again' }],
      targetPaths: ['packages/runner/src/mcp-handlers.ts'],
      predictedMetric: { name: 'toolFail:scm_clone_repo', direction: 'decrease', baseline: 5 },
    }),
  ]

  function withBoth(extra: Record<string, unknown>): Record<string, unknown> {
    return report(overlapping.map(entry => ({ ...entry, ...extra })))
  }

  it('refuses silence and lists every way out', () => {
    const problems = validateRetrospectiveReport(report(overlapping))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/finding-3 and finding-5 overlap/)
    expect(problems[0]).toMatch(/merge them/)
    expect(problems[0]).toMatch(/`rootCause`/)
    expect(problems[0]).toMatch(/`deliveryGroup`/)
    expect(problems[0]).toMatch(/`independentOf`/)
  })

  it('accepts a shared rootCause', () => {
    expect(validateRetrospectiveReport(withBoth({ rootCause: 'scm-clone-unhardened' }))).toEqual([])
  })

  it('accepts a shared deliveryGroup', () => {
    expect(validateRetrospectiveReport(withBoth({ deliveryGroup: 'mcp-handlers-clone' }))).toEqual([])
  })

  it('accepts a declared independence, but only with a reason', () => {
    const declared = report([
      { ...overlapping[0], independentOf: [{ findingId: 'finding-5', reason: 'different call path' }] },
      overlapping[1],
    ])
    expect(validateRetrospectiveReport(declared)).toEqual([])

    const unreasoned = report([
      { ...overlapping[0], independentOf: [{ findingId: 'finding-5' }] },
      overlapping[1],
    ])
    expect(validateRetrospectiveReport(unreasoned)).toHaveLength(1)
  })

  it('rejects a rootCause group that cannot ship as one change', () => {
    const mixedMetric = report([
      { ...overlapping[0], rootCause: 'scm-clone-unhardened' },
      {
        ...overlapping[1],
        rootCause: 'scm-clone-unhardened',
        predictedMetric: { name: 'costUsd', direction: 'decrease', baseline: 5 },
      },
    ])
    expect(validateRetrospectiveReport(mixedMetric).some(p => /predict different metrics/.test(p))).toBe(true)
  })

  it('rejects a rootCause group split across categories', () => {
    // Same paths and category-crossing: the pair is not flagged as an overlap,
    // but the group is still unshippable because category picks the destination.
    const mixedCategory = report([
      { ...overlapping[0], rootCause: 'shared' },
      { ...overlapping[1], rootCause: 'shared', category: 'base-intelligence' },
    ])
    expect(validateRetrospectiveReport(mixedCategory).some(p => /different categories/.test(p))).toBe(true)
  })
})
