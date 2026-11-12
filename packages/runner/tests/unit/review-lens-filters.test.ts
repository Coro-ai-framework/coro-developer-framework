import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import type { Finding, PrReview } from '@coro-ai/cloud-protocol'
import { anchorInDiff, lineInDiff, nearChangedLine, parseUnifiedDiff } from '../../src/reviews/diff-hunks'
import { dedupeFindings, sameFinding, titleOverlap } from '../../src/reviews/finding-match'
import { matchesGlob } from '../../src/reviews/glob'
import {
  applyLensRules,
  buildLensBrief,
  lensResultSchema,
  type LensFinding,
  type LensResult,
} from '../../src/reviews/lens-runner'
import { addDropped, attributeKept, roundOf, settleFinding, statsFor } from '../../src/reviews/lens-stats'
import { filterLensFindings, lensSlice, withOutsideDiffSection } from '../../src/tools/pr-review'
import { parseWorkflowConfig } from '../../src/workflow-parser'

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' one',
  '+two',
  ' three',
  ' four',
  '@@ -20,2 +21,2 @@',
  '-old',
  '+new',
  ' tail',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- /dev/null',
  '+++ b/src/b.ts',
  '(binary or too large for the SCM to return a patch)',
].join('\n')

describe('diff hunks', () => {
  const index = parseUnifiedDiff(DIFF)

  it('indexes hunks and added lines by path', () => {
    expect(index.get('src/a.ts')?.hunks).toHaveLength(2)
    expect([...index.get('src/a.ts')!.added]).toEqual([2, 21])
    expect([...index.get('src/a.ts')!.removed]).toEqual([20])
  })

  it('knows which lines the diff shows', () => {
    expect(lineInDiff(index, 'src/a.ts', 2)).toBe(true)
    expect(lineInDiff(index, 'src/a.ts', 4)).toBe(true)
    expect(lineInDiff(index, 'src/a.ts', 10)).toBe(false)
    expect(lineInDiff(index, 'src/a.ts', 20, 'LEFT')).toBe(true)
    expect(lineInDiff(index, 'src/missing.ts', 1)).toBe(false)
  })

  it('does not second-guess a file the SCM returned no patch for', () => {
    expect(anchorInDiff(index, 'src/b.ts', 5)).toBeUndefined()
    expect(anchorInDiff(index, 'src/unknown.ts', 5)).toBeUndefined()
    expect(anchorInDiff(index, 'src/a.ts', undefined)).toBeUndefined()
    expect(anchorInDiff(index, 'src/a.ts', 10)).toBe(false)
    expect(anchorInDiff(index, 'src/a.ts', 3)).toBe(true)
  })

  it('finds lines near a change', () => {
    expect(nearChangedLine(index, 'src/a.ts', 4)).toBe(true)
    expect(nearChangedLine(index, 'src/a.ts', 12)).toBe(false)
  })
})

describe('finding matching', () => {
  const base = { path: 'src/a.ts', line: 10, category: 'correctness', title: 'Retry loop never exits on a 4xx response' }

  it('matches the same id or fingerprint outright', () => {
    expect(sameFinding({ ...base, id: 'f1' }, { ...base, id: 'f1', title: 'Totally different' })).toBe(true)
    expect(sameFinding({ ...base, fingerprint: 'x' }, { ...base, fingerprint: 'x', path: 'src/z.ts', title: 'q' })).toBe(true)
  })

  it('matches a reworded title in the same place, but not another place or problem', () => {
    expect(sameFinding(base, { ...base, line: 12, title: 'The retry loop does not exit on 4xx responses' })).toBe(true)
    expect(sameFinding(base, { ...base, line: 40 })).toBe(false)
    expect(sameFinding(base, { ...base, title: 'Missing authorisation check on the export route' })).toBe(false)
    expect(sameFinding(base, { ...base, path: 'src/b.ts' })).toBe(false)
  })

  it('only crosses categories when asked, and then only with lines on both', () => {
    const other = { ...base, category: 'design', title: 'Retry loop never exits on 4xx response' }
    expect(sameFinding(base, other)).toBe(false)
    expect(sameFinding(base, other, { ignoreCategory: true })).toBe(true)
    expect(sameFinding(base, { ...other, line: undefined }, { ignoreCategory: true })).toBe(false)
  })

  it('measures title overlap on content words', () => {
    expect(titleOverlap('Retry loop never exits', 'retry loops exit never')).toBeGreaterThan(0.6)
    expect(titleOverlap('', 'anything')).toBe(0)
  })

  it('keeps the most severe copy of a duplicate', () => {
    const result = dedupeFindings([
      { ...base, severity: 'minor' },
      { ...base, line: 11, severity: 'major' },
      { ...base, path: 'src/other.ts', severity: 'nit' },
    ])
    expect(result.kept.map(item => item.severity)).toEqual(['major', 'nit'])
    expect(result.duplicates).toHaveLength(1)
  })
})

describe('globs', () => {
  it('crosses directories with ** and stays inside one with *', () => {
    expect(matchesGlob('docs/adr/**', 'docs/adr/0001/x.md')).toBe(true)
    expect(matchesGlob('docs/*.md', 'docs/a/b.md')).toBe(false)
    expect(matchesGlob('docs/*.md', 'docs/a.md')).toBe(true)
  })

  it('matches a bare pattern at any depth', () => {
    expect(matchesGlob('CODEOWNERS', 'a/b/CODEOWNERS')).toBe(true)
    expect(matchesGlob('*.proto', 'api/v1/x.proto')).toBe(true)
  })
})

function result(findings: Partial<LensFinding>[], notes?: string): LensResult {
  return lensResultSchema.parse({
    findings: findings.map(item => ({ severity: 'major', category: 'correctness', title: 'T', ...item })),
    ...(notes ? { notes } : {}),
  })
}

describe('lens rules', () => {
  it('moves low-confidence findings to the notes', () => {
    const { result: out, filtered } = applyLensRules('correctness', result([
      { title: 'Sure', confidence: 'high' },
      { title: 'Guess', confidence: 'low', path: 'a.ts', line: 3 },
      { title: 'No confidence given' },
    ], 'earlier'))
    expect(out.findings.map(item => item.title)).toEqual(['Sure', 'No confidence given'])
    expect(out.notes).toContain('earlier')
    expect(out.notes).toContain('Not raised (low confidence): Guess (a.ts:3)')
    expect(filtered).toEqual([expect.objectContaining({ reason: 'low-confidence', title: 'Guess', lens: 'correctness' })])
  })

  it('drops an unsourced architecture finding, and a history finding without a job or review source', () => {
    const arch = applyLensRules('architecture', result([
      { title: 'Cited', sources: [{ kind: 'adr', ref: 'docs/adr/1.md' }] },
      { title: 'Opinion' },
    ]))
    expect(arch.result.findings.map(item => item.title)).toEqual(['Cited'])
    expect(arch.filtered[0]?.reason).toBe('unsourced')

    const history = applyLensRules('history', result([
      { title: 'Cites a job', sources: [{ kind: 'job', ref: 'j-1' }] },
      { title: 'Cites a doc', sources: [{ kind: 'doc', ref: 'README.md' }] },
      { title: 'Cites a review', sources: [{ kind: 'review', ref: 'rev-0' }] },
    ]))
    expect(history.result.findings.map(item => item.title)).toEqual(['Cites a job', 'Cites a review'])
  })

  it('leaves the verifier alone', () => {
    const input = result([{ title: 'Kept', confidence: 'low' }])
    expect(applyLensRules('verifier', input)).toEqual({ result: input, filtered: [] })
  })

  it('accepts the new optional fields and the verifier dropped list', () => {
    const parsed = lensResultSchema.parse({
      findings: [{ severity: 'minor', category: 'tests', title: 'x', evidence: 'l', scenario: 's', confidence: 'medium', findingId: 'f_1', lens: 'tests' }],
      dropped: [{ title: 'y', reason: 'unchanged line' }],
    })
    expect(parsed.findings[0]?.findingId).toBe('f_1')
    expect(parsed.dropped?.[0]?.reason).toBe('unchanged line')
  })
})

describe('buildLensBrief', () => {
  const base = { lens: 'correctness', diffPath: 'pr/diff.patch', headDir: 'pr/head', paths: ['src/a.ts'], minSeverity: 'minor' as const }

  it('puts the slice, the floor, and the evidence rules in a pull-request brief', () => {
    const brief = buildLensBrief(base)
    expect(brief).toContain('pr/diff.patch')
    expect(brief).toContain('Changed files at the pull request head are under pr/head/')
    expect(brief).toContain('src/a.ts')
    expect(brief).toContain('Severity floor: minor')
    expect(brief).toContain('`scenario`')
  })

  it('tells a coding-job lens to read the checkout, not pr/head', () => {
    const brief = buildLensBrief({ ...base, headDir: undefined, checkout: '/work/svc', intent: { workItem: 'add-cache' } })
    expect(brief).toContain('/work/svc')
    expect(brief).toContain('working-tree')
    expect(brief).toContain('Work item: add-cache')
    expect(brief).not.toContain('pr/head')
  })

  it('carries the ledger, human threads, priors, and a delta pointer', () => {
    const brief = buildLensBrief({
      ...base,
      deltaPath: 'pr/delta.patch',
      ledger: [{ id: 'f_1', status: 'declined', severity: 'minor', path: 'src/a.ts', line: 4, title: 'Use a map' }],
      threads: [{ path: 'src/a.ts', line: 9, author: 'ada', excerpt: 'please rename this' }],
      priors: [{ path: 'src/a.ts', title: 'Prefer for-of', prTitle: 'Older PR' }],
      feedback: 'Reviewers ignore import-order remarks.',
    })
    expect(brief).toContain('pr/delta.patch')
    expect(brief).toContain('[f_1] declined minor src/a.ts:4 Use a map')
    expect(brief).toContain('findingId')
    expect(brief).toContain('please rename this')
    expect(brief).toContain('Prefer for-of')
    expect(brief).toContain('Reviewers ignore import-order remarks.')
  })

  it('briefs a verifier on candidates, not on a slice', () => {
    const brief = buildLensBrief({ ...base, lens: 'verifier', mode: 'verify', paths: [], candidates: [{ title: 'c1' }], relatedWorkPath: 'pr/related-work.md' })
    expect(brief).toContain('verifying candidates')
    expect(brief).toContain('"title":"c1"')
    expect(brief).toContain('pr/related-work.md')
    expect(brief).not.toContain('Your slice')
    expect(brief).toContain('"dropped"')
  })
})

describe('lensSlice', () => {
  const packet = {
    files: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.test.ts' }],
    routes: [{ name: 'correctness', paths: ['a.ts', 'b.ts'] }, { name: 'tests', paths: ['c.test.ts'] }],
    chunks: [{ index: 0, paths: ['a.ts'] }, { index: 1, paths: ['b.ts'] }],
  } as unknown as Parameters<typeof lensSlice>[1]

  it('gives each lens its routed files', () => {
    expect(lensSlice('correctness', packet, undefined)).toEqual(['a.ts', 'b.ts'])
    expect(lensSlice('tests', packet, undefined)).toEqual(['c.test.ts'])
  })

  it('narrows by the lead\'s paths or one chunk, but only within the route', () => {
    expect(lensSlice('correctness', packet, { paths: ['b.ts', 'c.test.ts'] })).toEqual(['b.ts'])
    expect(lensSlice('correctness', packet, { chunk: 1 })).toEqual(['b.ts'])
  })

  it('uses the lead\'s paths for a lens the packet did not route', () => {
    expect(lensSlice('history', packet, { paths: ['a.ts'] })).toEqual(['a.ts'])
    expect(lensSlice('history', packet, undefined)).toEqual(['a.ts', 'b.ts', 'c.test.ts'])
  })

  it('keeps only files the push touched on an incremental round, and gives the verifier none', () => {
    expect(lensSlice('correctness', packet, undefined, ['b.ts'])).toEqual(['b.ts'])
    expect(lensSlice('verifier', packet, undefined)).toEqual([])
  })
})

const finding = (extra: Partial<LensFinding>): LensFinding => lensResultSchema.parse({
  findings: [{ severity: 'major', category: 'correctness', path: 'src/a.ts', line: 10, title: 'Retry loop never exits on 4xx', ...extra }],
}).findings[0]!

const ledgerEntry = (extra: Partial<Finding>): Finding => ({
  id: 'f_1',
  fingerprint: 'zzz',
  severity: 'major',
  category: 'correctness',
  lens: 'correctness',
  path: 'src/a.ts',
  line: 10,
  title: 'Retry loop never exits on 4xx',
  status: 'open',
  raisedInRound: 1,
  lastTouchedRound: 1,
  ...extra,
} as Finding)

describe('filterLensFindings', () => {
  it('drops what the ledger already holds, as a duplicate or as declined', () => {
    const { kept, dropped } = filterLensFindings(
      [{ lens: 'correctness', findings: [finding({}), finding({ line: 50, title: 'Missing await on save' })] }],
      [ledgerEntry({ status: 'declined' })],
      [],
    )
    expect(kept[0]?.findings.map(item => item.title)).toEqual(['Missing await on save'])
    expect(dropped).toEqual([expect.objectContaining({ reason: 'declined', lens: 'correctness' })])

    const open = filterLensFindings([{ lens: 'correctness', findings: [finding({ findingId: 'f_1', title: 'Reworded entirely' })] }], [ledgerEntry({})], [])
    expect(open.dropped[0]?.reason).toBe('duplicate')
  })

  it('drops a problem declined on another pull request, except a blocker', () => {
    const prior = { reviewId: 'r0', path: 'src/a.ts', line: 11, title: 'Retry loop never exits on 4xx', severity: 'major', category: 'correctness', status: 'declined' } as const
    const soft = filterLensFindings([{ lens: 'correctness', findings: [finding({})] }], [], [prior])
    expect(soft.dropped[0]?.reason).toBe('prior-declined')
    const hard = filterLensFindings([{ lens: 'correctness', findings: [finding({ severity: 'blocker' })] }], [], [prior])
    expect(hard.kept[0]?.findings).toHaveLength(1)
  })

  it('keeps one copy of a problem two lenses raised under different categories', () => {
    const { kept, dropped } = filterLensFindings([
      { lens: 'correctness', findings: [finding({ severity: 'minor' })] },
      { lens: 'design', findings: [finding({ category: 'design', severity: 'major', line: 11, title: 'The retry loop never exits on 4xx' })] },
    ], [], [])
    expect(kept.flatMap(item => item.findings.map(entry => entry.severity))).toEqual(['major'])
    expect(kept[0]?.findings).toHaveLength(0)
    expect(dropped).toEqual([expect.objectContaining({ reason: 'duplicate', lens: 'correctness' })])
  })
})

describe('review body for lines outside the diff', () => {
  const outside = [{ path: 'src/a.ts', line: 90, severity: 'minor' as const, title: 'Unchecked cast', body: 'Not\nchanged here.' }]

  it('appends one section and replaces it on the next submit', () => {
    const once = withOutsideDiffSection('Summary.', outside)
    expect(once).toContain('### Also noticed, outside the changed lines')
    expect(once).toContain('`src/a.ts:90` Unchecked cast — Not changed here.')
    const twice = withOutsideDiffSection(once, outside)
    expect(twice).toBe(once)
    expect(twice.match(/Also noticed/g)).toHaveLength(1)
  })

  it('removes the section when nothing is outside the diff any more', () => {
    const once = withOutsideDiffSection('Summary.', outside)
    expect(withOutsideDiffSection(once, [])).toBe('Summary.')
  })
})

describe('lens funnel statistics', () => {
  function review(): PrReview {
    return {
      rounds: [{ round: 1, jobId: 'job-1', lensCosts: {} }, { round: 2, jobId: 'job-2' }],
      ledger: { findings: [] },
    } as unknown as PrReview
  }

  it('finds a round by job or number and creates stats on demand', () => {
    const r = review()
    expect(roundOf(r, { jobId: 'job-2' })?.round).toBe(2)
    expect(roundOf(r, { round: 1 })?.jobId).toBe('job-1')
    const stats = statsFor(roundOf(r, { jobId: 'job-2' })!, 'tests')
    expect(stats).toEqual({ costUsd: 0, inputTokens: 0, outputTokens: 0, findings: 0 })
    addDropped(stats, 'duplicate')
    addDropped(stats, 'duplicate', 2)
    expect(stats.droppedByRunner).toEqual({ duplicate: 3 })
  })

  it('credits a kept finding to the lens that raised it, even after the verifier rewords it', () => {
    const counts = attributeKept(
      [{ lens: 'security', path: 'a.ts', line: 3, category: 'security', title: 'SQL built from user input' }],
      [
        { path: 'a.ts', line: 3, category: 'security', title: 'SQL query built from user input' },
        { lens: 'design', category: 'design', title: 'Named lens' },
      ],
    )
    expect(counts.get('security')).toBe(1)
    expect(counts.get('design')).toBe(1)
  })

  it('records how a finding was settled, and tallies the lens only for a move out of open', () => {
    const r = review()
    const first = roundOf(r, { round: 1 })!
    statsFor(first, 'correctness')
    const a = ledgerEntry({ raisedInRound: 1 })
    settleFinding(r, a, 'addressed')
    expect(a.resolution).toBe('resolved')
    expect(first.lensCosts!['correctness']!.addressed).toBe(1)
    settleFinding(r, a, 'addressed')
    expect(first.lensCosts!['correctness']!.addressed).toBe(1)

    const b = ledgerEntry({ id: 'f_2', raisedInRound: 1 })
    settleFinding(r, b, 'declined')
    expect(first.lensCosts!['correctness']!.declined).toBe(1)

    const c = ledgerEntry({ id: 'f_3', raisedInRound: 1 })
    settleFinding(r, c, 'addressed', 'closed-open')
    expect(c.resolution).toBe('closed-open')
    expect(first.lensCosts!['correctness']!.addressed).toBe(1)

    settleFinding(r, a, 'open')
    expect(a.resolution).toBeUndefined()
  })
})

describe('pr-review workflow', () => {
  const markdown = readFileSync(path.resolve(__dirname, '../../../intelligence-base/layer/workflows/pr-review/workflow.md'), 'utf8')
  const review = parseWorkflowConfig(markdown).phases.find(item => item.name === 'review')!

  it('declares the history lens with the drill-down tool, and gives it to the verifier', () => {
    const history = review.lenses?.find(lens => lens.name === 'history')
    expect(history?.agent).toBe('agents/review-history.md')
    expect(history?.tools).toContain('mcp__coro__review_related_work')
    expect(review.lenses?.find(lens => lens.name === 'verifier')?.tools).toContain('mcp__coro__review_related_work')
  })

  it('keeps the verifier last so it can check what the others raised', () => {
    expect(review.lenses?.at(-1)?.name).toBe('verifier')
  })

  it('ships an agent file for every declared lens', () => {
    for (const lens of review.lenses ?? []) {
      expect(() => readFileSync(path.resolve(__dirname, '../../../intelligence-base/layer', lens.agent), 'utf8')).not.toThrow()
    }
  })
})
