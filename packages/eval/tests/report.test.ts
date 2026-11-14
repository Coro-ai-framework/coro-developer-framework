import { describe, expect, it } from 'vitest'
import {
  compareRuns,
  formatDuration,
  formatUsd,
  historyRows,
  parseMetric,
  passAtK,
  passPowK,
  pooledSpread,
  renderComparison,
  renderHistory,
  renderReport,
  renderTable,
  summarize,
} from '../src/report'
import type { IndexRecord, RunInfo } from '../src/store'
import { resolveScenario } from '../src/scenario'

let counter = 0
function rec(overrides: Partial<IndexRecord> = {}): IndexRecord {
  counter++
  return {
    runId: 'run-a',
    label: 'a',
    ts: new Date(Date.UTC(2024, 0, 1, 0, 0, counter)).toISOString(),
    coroSha: 'abcdef1234567',
    harnessSha: '1234567abcdef',
    scenarioHash: 'hash',
    lane: 'standard',
    taskId: 't1',
    attempt: 1,
    solved: true,
    outcome: 'complete',
    expectedOutcomeMet: true,
    costUsd: 1,
    wallMs: 60_000,
    agentMs: 50_000,
    reviewWaitMs: 5_000,
    phaseRuns: 5,
    reworkRuns: 0,
    inputTokens: 1000,
    outputTokens: 500,
    ...overrides,
  }
}

const many = (taskId: string, runId: string, costs: number[], solved: boolean[] = costs.map(() => true)): IndexRecord[] =>
  costs.map((costUsd, i) => rec({ taskId, runId, attempt: i + 1, costUsd, solved: solved[i] ?? true }))

describe('pass@k and pass^k', () => {
  it('pass@k: solved at least once', () => {
    expect(passAtK([false, false, true])).toBe(true)
    expect(passAtK([false, false])).toBe(false)
    expect(passAtK([])).toBe(false)
  })

  it('pass^k: solved every time', () => {
    expect(passPowK([true, true, true])).toBe(true)
    expect(passPowK([true, false, true])).toBe(false)
  })

  it('pass^k is false with no attempts, not vacuously true', () => {
    expect(passPowK([])).toBe(false)
  })
})

describe('summarize', () => {
  const records = [
    ...many('t1', 'r', [1, 2, 3], [true, true, false]),
    ...many('t2', 'r', [4, 4], [false, false]),
    ...many('t3', 'r', [0.5, 0.5], [true, true]),
  ]
  const summary = summarize(records)
  const task = (id: string) => summary.tasks.find(t => t.taskId === id)!

  it('rates each task and says whether it passed once or every time', () => {
    expect(task('t1')).toMatchObject({ attempts: 3, solved: 2, passAtK: true, passPowK: false })
    expect(task('t1').solveRate).toBeCloseTo(2 / 3)
    expect(task('t2')).toMatchObject({ solved: 0, passAtK: false, passPowK: false, costPerSolvedUsd: null })
    expect(task('t3')).toMatchObject({ solved: 2, passAtK: true, passPowK: true })
  })

  it('takes medians of cost, time and rework per task', () => {
    expect(task('t1').medianCostUsd).toBe(2)
    expect(task('t3').medianCostUsd).toBe(0.5)
    expect(task('t1').medianWallMs).toBe(60_000)
  })

  it('charges failures to the cost per solved attempt', () => {
    expect(task('t1').totalCostUsd).toBe(6)
    expect(task('t1').costPerSolvedUsd).toBe(3)
    expect(task('t3').costPerSolvedUsd).toBe(0.5)
  })

  it('counts outcomes', () => {
    const mixed = summarize([rec({ outcome: 'complete' }), rec({ outcome: 'timeout' }), rec({ outcome: 'timeout' })])
    expect(mixed.tasks[0]!.outcomes).toEqual({ complete: 1, timeout: 2 })
  })

  it('sums up the whole run', () => {
    expect(summary.overall).toMatchObject({ tasks: 3, attempts: 7, solved: 4 })
    expect(summary.overall.solveRate).toBeCloseTo(4 / 7)
    expect(summary.overall.passAtKRate).toBeCloseTo(2 / 3)
    expect(summary.overall.passPowKRate).toBeCloseTo(1 / 3)
    expect(summary.overall.totalCostUsd).toBe(15)
    expect(summary.overall.costPerSolvedUsd).toBe(3.75)
  })

  it('averages judge scores only over attempts that were judged', () => {
    const judged = summarize([
      rec({ judge: { correctness: 5, scopeDiscipline: 5, readability: 5, testQuality: 5, risk: 5, mean: 5 } }),
      rec({ judge: { correctness: 3, scopeDiscipline: 3, readability: 3, testQuality: 3, risk: 3, mean: 3 } }),
      rec(),
    ])
    expect(judged.overall.meanJudge).toBe(4)
    expect(summarize([rec()]).overall.meanJudge).toBeUndefined()
  })

  it('handles an empty run', () => {
    const empty = summarize([])
    expect(empty.tasks).toEqual([])
    expect(empty.overall).toMatchObject({ attempts: 0, solveRate: 0, costPerSolvedUsd: null })
  })

  it('has no cost per solved attempt when nothing was solved', () => {
    expect(summarize([rec({ solved: false, costUsd: 5 })]).overall.costPerSolvedUsd).toBeNull()
  })
})

describe('pooledSpread', () => {
  it('is the root-mean-square of the per-task standard deviations', () => {
    // sd of [1,2,3] is 1; sd of [10,12] is sqrt(2)
    expect(pooledSpread([[1, 2, 3], [10, 12]])).toBeCloseTo(Math.sqrt((1 + 2) / 2))
  })

  it('skips tasks with a single value, and is undefined if none have two', () => {
    expect(pooledSpread([[1], [1, 3]])).toBeCloseTo(Math.SQRT2)
    expect(pooledSpread([[1], [2]])).toBeUndefined()
    expect(pooledSpread([])).toBeUndefined()
  })
})

describe('compareRuns', () => {
  const a = [
    ...many('t1', 'a', [1.0, 1.2, 1.1]),
    ...many('t2', 'a', [1, 2, 3]),
    ...many('t3', 'a', [1]),
    ...many('only-a', 'a', [1, 1]),
  ]
  const b = [
    ...many('t1', 'b', [2.0, 2.2, 2.1]),
    ...many('t2', 'b', [2.0, 2.5, 3.5]),
    ...many('t3', 'b', [3]),
    ...many('only-b', 'b', [1, 1]),
  ]
  const comparison = compareRuns(a, b)
  const cost = (taskId: string) => comparison.tasks.find(t => t.taskId === taskId)!.metrics.find(m => m.metric === 'costUsd')!

  it('compares only the tasks both runs attempted, and names the rest', () => {
    expect(comparison.tasks.map(t => t.taskId)).toEqual(['t1', 't2', 't3'])
    expect(comparison.onlyInA).toEqual(['only-a'])
    expect(comparison.onlyInB).toEqual(['only-b'])
  })

  it('reports delta as B minus A', () => {
    expect(cost('t1').a).toBeCloseTo(1.1)
    expect(cost('t1').b).toBeCloseTo(2.1)
    expect(cost('t1').delta).toBeCloseTo(1.0)
  })

  it('calls a change larger than the spread real, in the right direction', () => {
    // cost: lower is better, and it went up by 1.0 against a spread of 0.1
    expect(cost('t1').verdict).toBe('worse')
    const cheaper = compareRuns(many('t1', 'a', [2.0, 2.2, 2.1]), many('t1', 'b', [1.0, 1.2, 1.1]))
    expect(cheaper.tasks[0]!.metrics.find(m => m.metric === 'costUsd')!.verdict).toBe('better')
  })

  it('calls a change inside the spread noise', () => {
    // delta 0.67 against sds of 1.0 and 0.76
    expect(cost('t2').verdict).toBe('noise')
    expect(cost('t2').spread).toBeCloseTo(1)
  })

  it('does not judge a task that has a single attempt on either side', () => {
    expect(cost('t3').verdict).toBe('unknown')
    expect(cost('t3').delta).toBe(2)
  })

  it('knows that a higher solve rate is better', () => {
    const lower = compareRuns(many('t', 'a', [1, 1, 1], [true, true, true]), many('t', 'b', [1, 1, 1], [false, false, false]))
    const m = lower.tasks[0]!.metrics.find(x => x.metric === 'solveRate')!
    expect(m.delta).toBe(-1)
    // both runs are perfectly steady, so a drop from 100% to 0% is not noise
    expect(m.verdict).toBe('worse')
    const higher = compareRuns(many('t', 'a', [1, 1, 1], [false, false, false]), many('t', 'b', [1, 1, 1], [true, true, true]))
    expect(higher.tasks[0]!.metrics.find(x => x.metric === 'solveRate')!.verdict).toBe('better')
  })

  it('calls identical results noise rather than better or worse', () => {
    const same = compareRuns(many('t', 'a', [1, 1]), many('t', 'b', [1, 1]))
    expect(same.tasks[0]!.metrics.find(x => x.metric === 'costUsd')!.verdict).toBe('noise')
  })

  it('marks a metric missing on one side as n/a', () => {
    const judge = comparison.tasks[0]!.metrics.find(m => m.metric === 'judge')!
    expect(judge.verdict).toBe('n/a')
    expect(judge.delta).toBeUndefined()
  })

  it('averages over the shared tasks for the overall line, judged against a spread shrunk by task count', () => {
    const overall = comparison.overall.metrics.find(m => m.metric === 'costUsd')!
    expect(comparison.overall.tasks).toBe(3)
    expect(overall.a).toBeCloseTo((1.1 + 2 + 1) / 3)
    expect(overall.b).toBeCloseTo((2.1 + 8 / 3 + 3) / 3)
    const spreadA = Math.sqrt((0.01 + 1) / 2)
    const spreadB = Math.sqrt((0.01 + 0.58333) / 2)
    expect(overall.spread).toBeCloseTo(Math.max(spreadA, spreadB) / Math.sqrt(3), 3)
    expect(overall.verdict).toBe('worse')
  })

  it('is empty when the runs share no task', () => {
    const none = compareRuns(many('x', 'a', [1]), many('y', 'b', [1]))
    expect(none.tasks).toEqual([])
    expect(none.overall.tasks).toBe(0)
  })
})

describe('historyRows', () => {
  const at = (day: number, runId: string, overrides: Partial<IndexRecord>): IndexRecord =>
    rec({ runId, label: runId, ts: new Date(Date.UTC(2024, 0, day)).toISOString(), ...overrides })
  const records = [
    at(3, 'r3', { taskId: 't1', costUsd: 1, solved: true }),
    at(1, 'r1', { taskId: 't1', costUsd: 4, solved: false }),
    at(1, 'r1', { taskId: 't2', costUsd: 2, solved: true }),
    at(2, 'r2', { taskId: 't1', costUsd: 2, solved: true }),
    at(2, 'r2', { taskId: 't2', costUsd: 2, solved: true }),
  ]

  it('orders runs by when they happened and shows the change from the one before', () => {
    const rows = historyRows(records, { metric: 'costUsd' })
    expect(rows.map(r => r.runId)).toEqual(['r1', 'r2', 'r3'])
    expect(rows.map(r => r.value)).toEqual([3, 2, 1])
    expect(rows.map(r => r.delta)).toEqual([undefined, -1, -1])
  })

  it('can follow a single task', () => {
    const rows = historyRows(records, { metric: 'solveRate', task: 't1' })
    expect(rows.map(r => r.value)).toEqual([0, 1, 1])
    expect(rows.every(r => r.attempts === 1)).toBe(true)
  })

  it('skips runs that never attempted the task', () => {
    const rows = historyRows(records, { metric: 'costUsd', task: 't2' })
    expect(rows.map(r => r.runId)).toEqual(['r1', 'r2'])
  })

  it('leaves the value out where a run has no data for the metric', () => {
    const rows = historyRows(records, { metric: 'judge' })
    expect(rows.every(r => r.value === undefined)).toBe(true)
  })
})

describe('parseMetric', () => {
  it('accepts exact names, case-insensitively, and a few short aliases', () => {
    expect(parseMetric('costUsd')).toBe('costUsd')
    expect(parseMetric('COSTUSD')).toBe('costUsd')
    expect(parseMetric('cost')).toBe('costUsd')
    expect(parseMetric('solved')).toBe('solveRate')
    expect(parseMetric('rework')).toBe('reworkRuns')
  })

  it('lists the choices when the name is wrong', () => {
    expect(() => parseMetric('speed')).toThrow(/Unknown metric "speed"[\s\S]*costUsd/)
  })
})

describe('formatting', () => {
  it('formats durations compactly', () => {
    expect(formatDuration(450)).toBe('450ms')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(192_000)).toBe('3m12s')
    expect(formatDuration(3_720_000)).toBe('1h02m')
    expect(formatDuration(Number.NaN)).toBe('-')
  })

  it('formats cost with more precision when it is small', () => {
    expect(formatUsd(0.1234)).toBe('$0.123')
    expect(formatUsd(12.345)).toBe('$12.35')
  })
})

describe('rendering', () => {
  const info: RunInfo = {
    runId: '2024-01-01T10-00-00_baseline',
    label: 'baseline',
    startedAt: '2024-01-01T10:00:00Z',
    scenario: resolveScenario({ overrides: ['models.coding=claude-sonnet-5-5'] }),
    scenarioHash: 'deadbeef',
    overrides: [],
    coroPath: '/coro',
    coroSha: 'abcdef1234567',
    coroDirty: true,
    harnessSha: '1234567abcdef',
    harnessDirty: false,
    tasks: ['t1'],
  }

  it('renders a text table with aligned columns', () => {
    const text = renderTable({ headers: ['task', 'n'], rows: [['alpha', '3'], ['b', '12']] }, 'text')
    expect(text.split('\n')).toEqual(['task   n', '-----  --', 'alpha  3', 'b      12'])
  })

  it('renders a Markdown table and escapes pipes', () => {
    const md = renderTable({ headers: ['a', 'b'], rows: [['x|y', '1']] }, 'markdown')
    expect(md.split('\n')).toEqual(['| a | b |', '| --- | --- |', '| x\\|y | 1 |'])
  })

  it('puts the commits, lane and models in the report header and the totals at the bottom', () => {
    const text = renderReport(info, summarize(many('t1', 'r', [1, 2], [true, false])))
    expect(text).toContain('abcdef1+dirty')
    expect(text).toContain('harness 1234567')
    expect(text).toContain('2 complete')
    expect(text).toContain('lane standard')
    expect(text).toContain('coding=claude-sonnet-5-5')
    expect(text).toContain('solve rate 50% (1/2 attempts over 1 tasks)')
    expect(text).toContain('cost per solved attempt $3.00')
    expect(text).toContain('t1')
  })

  it('renders the same report as Markdown', () => {
    const md = renderReport(info, summarize(many('t1', 'r', [1])), 'markdown')
    expect(md).toContain('# Run 2024-01-01T10-00-00_baseline')
    expect(md).toContain('| task | n |')
    expect(md).toContain('## Overall')
  })

  it('renders a comparison that says what is noise', () => {
    const comparison = compareRuns(many('t1', 'a', [1, 3]), many('t1', 'b', [2, 3.5]))
    const text = renderComparison({ id: 'a', label: 'old' }, { id: 'b', label: 'new' }, comparison)
    expect(text).toContain('A: a (old)')
    expect(text).toContain('B: b (new)')
    expect(text).toContain('Deltas are B minus A')
    expect(text).toContain('noise')
  })

  it('renders history with the change since the previous run', () => {
    const rows = historyRows(
      [rec({ runId: 'r1', label: 'one', costUsd: 2, ts: '2024-01-01T00:00:00Z' }), rec({ runId: 'r2', label: 'two', costUsd: 1, ts: '2024-01-02T00:00:00Z' })],
      { metric: 'costUsd' },
    )
    const text = renderHistory(rows, { metric: 'costUsd' })
    expect(text).toContain('History of cost over all tasks')
    expect(text).toContain('-$1.00')
  })
})
