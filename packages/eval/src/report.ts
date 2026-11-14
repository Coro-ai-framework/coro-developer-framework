import type { IndexRecord, RunInfo } from './store'
import { mean, median, round, stdev, sum } from './util'

/**
 * Summaries, paired comparisons and trends over `index.jsonl` records.
 *
 * Everything here is a pure function of the records it is given, so the maths
 * is unit-tested without running a model, and every number in a report can be
 * recomputed from the files on disk.
 */

// ── Pass rates ───────────────────────────────────────────────────────────────

/** pass@k: the task was solved at least once in its `k` attempts. */
export function passAtK(results: readonly boolean[]): boolean {
  return results.some(Boolean)
}

/**
 * pass^k: the task was solved in every one of its `k` attempts. For an
 * autonomous agent this is the number that matters: a result you cannot repeat
 * is not one you can rely on.
 */
export function passPowK(results: readonly boolean[]): boolean {
  return results.length > 0 && results.every(Boolean)
}

// ── Summaries ────────────────────────────────────────────────────────────────

export interface TaskSummary {
  taskId: string
  attempts: number
  solved: number
  solveRate: number
  passAtK: boolean
  passPowK: boolean
  totalCostUsd: number
  /** Total spend on this task divided by its solved attempts; failures count. Null if none solved. */
  costPerSolvedUsd: number | null
  medianCostUsd: number
  medianWallMs: number
  medianAgentMs: number
  medianReviewWaitMs: number
  medianReworkRuns: number
  meanJudge?: number
  /** How the attempts ended, e.g. `{ complete: 3, timeout: 1 }`. */
  outcomes: Record<string, number>
}

export interface OverallSummary {
  tasks: number
  attempts: number
  solved: number
  solveRate: number
  /** Share of tasks solved at least once. */
  passAtKRate: number
  /** Share of tasks solved every time. */
  passPowKRate: number
  totalCostUsd: number
  /** All spend, failed attempts included, divided by solved attempts. Null if none solved. */
  costPerSolvedUsd: number | null
  medianCostUsd: number
  medianWallMs: number
  medianAgentMs: number
  medianReworkRuns: number
  meanJudge?: number
  outcomes: Record<string, number>
}

export interface RunSummary {
  tasks: TaskSummary[]
  overall: OverallSummary
}

function countOutcomes(records: readonly IndexRecord[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const record of records) counts[record.outcome] = (counts[record.outcome] ?? 0) + 1
  return counts
}

function judgeMean(records: readonly IndexRecord[]): number | undefined {
  const scores = records.flatMap(r => (r.judge ? [r.judge.mean] : []))
  const avg = mean(scores)
  return avg === undefined ? undefined : round(avg, 2)
}

function medianOf(records: readonly IndexRecord[], pick: (r: IndexRecord) => number): number {
  return median(records.map(pick)) ?? 0
}

export function groupByTask(records: readonly IndexRecord[]): Map<string, IndexRecord[]> {
  const byTask = new Map<string, IndexRecord[]>()
  for (const record of records) {
    const list = byTask.get(record.taskId) ?? []
    list.push(record)
    byTask.set(record.taskId, list)
  }
  return byTask
}

export function summarizeTask(taskId: string, records: readonly IndexRecord[]): TaskSummary {
  const solved = records.filter(r => r.solved).length
  const totalCostUsd = round(sum(records.map(r => r.costUsd)))
  const judge = judgeMean(records)
  const results = records.map(r => r.solved)
  return {
    taskId,
    attempts: records.length,
    solved,
    solveRate: records.length === 0 ? 0 : solved / records.length,
    passAtK: passAtK(results),
    passPowK: passPowK(results),
    totalCostUsd,
    costPerSolvedUsd: solved > 0 ? round(totalCostUsd / solved) : null,
    medianCostUsd: round(medianOf(records, r => r.costUsd)),
    medianWallMs: medianOf(records, r => r.wallMs),
    medianAgentMs: medianOf(records, r => r.agentMs),
    medianReviewWaitMs: medianOf(records, r => r.reviewWaitMs),
    medianReworkRuns: medianOf(records, r => r.reworkRuns),
    ...(judge !== undefined ? { meanJudge: judge } : {}),
    outcomes: countOutcomes(records),
  }
}

export function summarize(records: readonly IndexRecord[]): RunSummary {
  const tasks = [...groupByTask(records).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([taskId, taskRecords]) => summarizeTask(taskId, taskRecords))

  const solved = records.filter(r => r.solved).length
  const totalCostUsd = round(sum(records.map(r => r.costUsd)))
  const judge = judgeMean(records)
  return {
    tasks,
    overall: {
      tasks: tasks.length,
      attempts: records.length,
      solved,
      solveRate: records.length === 0 ? 0 : solved / records.length,
      passAtKRate: tasks.length === 0 ? 0 : tasks.filter(t => t.passAtK).length / tasks.length,
      passPowKRate: tasks.length === 0 ? 0 : tasks.filter(t => t.passPowK).length / tasks.length,
      totalCostUsd,
      costPerSolvedUsd: solved > 0 ? round(totalCostUsd / solved) : null,
      medianCostUsd: round(medianOf(records, r => r.costUsd)),
      medianWallMs: medianOf(records, r => r.wallMs),
      medianAgentMs: medianOf(records, r => r.agentMs),
      medianReworkRuns: medianOf(records, r => r.reworkRuns),
      ...(judge !== undefined ? { meanJudge: judge } : {}),
      outcomes: countOutcomes(records),
    },
  }
}

// ── Metrics, shared by compare and history ───────────────────────────────────

export type MetricKey =
  | 'solveRate'
  | 'costUsd'
  | 'wallMs'
  | 'agentMs'
  | 'reviewWaitMs'
  | 'reworkRuns'
  | 'phaseRuns'
  | 'inputTokens'
  | 'outputTokens'
  | 'judge'

interface MetricDef {
  key: MetricKey
  label: string
  lowerIsBetter: boolean
  pick(record: IndexRecord): number | undefined
  format(value: number): string
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '-'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  const totalSeconds = Math.round(ms / 1_000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(value < 1 ? 3 : 2)}`
}

export function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatCount(value: number): string {
  return value >= 100 ? String(Math.round(value)) : String(round(value, 2))
}

const METRICS: Record<MetricKey, MetricDef> = {
  solveRate: { key: 'solveRate', label: 'solve rate', lowerIsBetter: false, pick: r => (r.solved ? 1 : 0), format: formatPct },
  costUsd: { key: 'costUsd', label: 'cost', lowerIsBetter: true, pick: r => r.costUsd, format: formatUsd },
  wallMs: { key: 'wallMs', label: 'wall time', lowerIsBetter: true, pick: r => r.wallMs, format: formatDuration },
  agentMs: { key: 'agentMs', label: 'agent time', lowerIsBetter: true, pick: r => r.agentMs, format: formatDuration },
  reviewWaitMs: { key: 'reviewWaitMs', label: 'review wait', lowerIsBetter: true, pick: r => r.reviewWaitMs, format: formatDuration },
  reworkRuns: { key: 'reworkRuns', label: 'rework runs', lowerIsBetter: true, pick: r => r.reworkRuns, format: formatCount },
  phaseRuns: { key: 'phaseRuns', label: 'phase runs', lowerIsBetter: true, pick: r => r.phaseRuns, format: formatCount },
  inputTokens: { key: 'inputTokens', label: 'input tokens', lowerIsBetter: true, pick: r => r.inputTokens, format: formatCount },
  outputTokens: { key: 'outputTokens', label: 'output tokens', lowerIsBetter: true, pick: r => r.outputTokens, format: formatCount },
  judge: { key: 'judge', label: 'judge mean', lowerIsBetter: false, pick: r => r.judge?.mean, format: v => v.toFixed(2) },
}

export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[]

/** Accepts the metric names a person would type: `costUsd`, `cost`, `solved`, ... */
export function parseMetric(name: string): MetricKey {
  const aliases: Record<string, MetricKey> = { solved: 'solveRate', cost: 'costUsd', wall: 'wallMs', agent: 'agentMs', rework: 'reworkRuns' }
  const key = aliases[name] ?? (METRIC_KEYS.find(k => k.toLowerCase() === name.toLowerCase()) as MetricKey | undefined)
  if (!key) throw new Error(`Unknown metric "${name}". Choose one of: ${METRIC_KEYS.join(', ')}`)
  return key
}

function valuesOf(records: readonly IndexRecord[], metric: MetricDef): number[] {
  return records.flatMap(r => {
    const value = metric.pick(r)
    return value === undefined ? [] : [value]
  })
}

// ── Paired comparison ────────────────────────────────────────────────────────

export type Verdict =
  /** Moved in the good direction by more than the run-to-run spread. */
  | 'better'
  | 'worse'
  /** Within the run-to-run spread: not distinguishable from chance. */
  | 'noise'
  /** One side has fewer than two attempts, so there is no spread to judge against. */
  | 'unknown'
  /** The metric is missing on one side. */
  | 'n/a'

export interface MetricComparison {
  metric: MetricKey
  a?: number
  b?: number
  /** `b - a`. */
  delta?: number
  /** The run-to-run spread the delta was judged against. */
  spread?: number
  verdict: Verdict
}

export interface TaskComparison {
  taskId: string
  attemptsA: number
  attemptsB: number
  metrics: MetricComparison[]
}

export interface Comparison {
  tasks: TaskComparison[]
  onlyInA: string[]
  onlyInB: string[]
  /** Averages over the tasks both runs contain. */
  overall: { tasks: number; metrics: MetricComparison[] }
}

export const COMPARE_METRICS: MetricKey[] = ['solveRate', 'costUsd', 'wallMs', 'agentMs', 'reworkRuns', 'judge']

function judge(def: MetricDef, a: number | undefined, b: number | undefined, spread: number | undefined): MetricComparison {
  const base = { metric: def.key, ...(a !== undefined ? { a } : {}), ...(b !== undefined ? { b } : {}) }
  if (a === undefined || b === undefined) return { ...base, verdict: 'n/a' }
  const delta = b - a
  if (spread === undefined) return { ...base, delta, verdict: 'unknown' }
  if (Math.abs(delta) <= spread) return { ...base, delta, spread, verdict: 'noise' }
  const improved = def.lowerIsBetter ? delta < 0 : delta > 0
  return { ...base, delta, spread, verdict: improved ? 'better' : 'worse' }
}

/** Root-mean-square of the per-task standard deviations: how much one task's result wobbles between attempts. */
export function pooledSpread(valuesPerTask: ReadonlyArray<readonly number[]>): number | undefined {
  const variances = valuesPerTask.flatMap(values => {
    const sd = stdev(values)
    return sd === undefined ? [] : [sd ** 2]
  })
  if (variances.length === 0) return undefined
  return Math.sqrt(sum(variances) / variances.length)
}

/**
 * Compare run A with run B task by task. Both runs must have attempted a task
 * for it to count; `delta` is always `b - a`.
 *
 * Every difference is judged against the spread between attempts of the same
 * task: the larger of the two runs' standard deviations. A change smaller than
 * that is reported as `noise`, because with only a few attempts per task a
 * difference that size appears by chance alone. With a single attempt on
 * either side there is no spread to judge by, and the verdict is `unknown`.
 *
 * Overall, the per-task means are averaged, and the spread is the pooled
 * per-task spread shrunk by the square root of the number of tasks, since an
 * average over T tasks wobbles less than any one of them.
 */
export function compareRuns(recordsA: readonly IndexRecord[], recordsB: readonly IndexRecord[]): Comparison {
  const byTaskA = groupByTask(recordsA)
  const byTaskB = groupByTask(recordsB)
  const shared = [...byTaskA.keys()].filter(id => byTaskB.has(id)).sort()

  const tasks: TaskComparison[] = shared.map(taskId => {
    const a = byTaskA.get(taskId)!
    const b = byTaskB.get(taskId)!
    return {
      taskId,
      attemptsA: a.length,
      attemptsB: b.length,
      metrics: COMPARE_METRICS.map(key => {
        const def = METRICS[key]
        const valuesA = valuesOf(a, def)
        const valuesB = valuesOf(b, def)
        const sdA = stdev(valuesA)
        const sdB = stdev(valuesB)
        const spread = sdA !== undefined && sdB !== undefined ? Math.max(sdA, sdB) : undefined
        return judge(def, mean(valuesA), mean(valuesB), spread)
      }),
    }
  })

  const overall = COMPARE_METRICS.map(key => {
    const def = METRICS[key]
    const perTaskA: number[][] = []
    const perTaskB: number[][] = []
    const meansA: number[] = []
    const meansB: number[] = []
    for (const taskId of shared) {
      const valuesA = valuesOf(byTaskA.get(taskId)!, def)
      const valuesB = valuesOf(byTaskB.get(taskId)!, def)
      const mA = mean(valuesA)
      const mB = mean(valuesB)
      if (mA === undefined || mB === undefined) continue
      perTaskA.push(valuesA)
      perTaskB.push(valuesB)
      meansA.push(mA)
      meansB.push(mB)
    }
    const spreadA = pooledSpread(perTaskA)
    const spreadB = pooledSpread(perTaskB)
    const spread =
      spreadA !== undefined && spreadB !== undefined && meansA.length > 0
        ? Math.max(spreadA, spreadB) / Math.sqrt(meansA.length)
        : undefined
    return judge(def, mean(meansA), mean(meansB), spread)
  })

  return {
    tasks,
    onlyInA: [...byTaskA.keys()].filter(id => !byTaskB.has(id)).sort(),
    onlyInB: [...byTaskB.keys()].filter(id => !byTaskA.has(id)).sort(),
    overall: { tasks: shared.length, metrics: overall },
  }
}

// ── History ──────────────────────────────────────────────────────────────────

export interface HistoryRow {
  runId: string
  label: string
  ts: string
  coroSha: string | null
  attempts: number
  solveRate: number
  /** Mean of the chosen metric over the run's (optionally one task's) attempts. */
  value?: number
  /** Change from the previous row's value. */
  delta?: number
}

export function historyRows(
  records: readonly IndexRecord[],
  options: { task?: string; metric: MetricKey },
): HistoryRow[] {
  const def = METRICS[options.metric]
  const filtered = options.task ? records.filter(r => r.taskId === options.task) : records
  const byRun = new Map<string, IndexRecord[]>()
  for (const record of filtered) {
    const list = byRun.get(record.runId) ?? []
    list.push(record)
    byRun.set(record.runId, list)
  }

  const rows: HistoryRow[] = [...byRun.entries()].map(([runId, runRecords]) => {
    const first = [...runRecords].sort((a, b) => a.ts.localeCompare(b.ts))[0]!
    const value = mean(valuesOf(runRecords, def))
    return {
      runId,
      label: first.label,
      ts: first.ts,
      coroSha: first.coroSha,
      attempts: runRecords.length,
      solveRate: runRecords.filter(r => r.solved).length / runRecords.length,
      ...(value !== undefined ? { value } : {}),
    }
  })
  rows.sort((a, b) => a.ts.localeCompare(b.ts))

  let previous: number | undefined
  for (const row of rows) {
    if (row.value !== undefined && previous !== undefined) row.delta = row.value - previous
    if (row.value !== undefined) previous = row.value
  }
  return rows
}

// ── Rendering ────────────────────────────────────────────────────────────────

export type RenderFormat = 'text' | 'markdown'

export interface Table {
  headers: string[]
  rows: string[][]
}

export function renderTable(table: Table, format: RenderFormat): string {
  const { headers, rows } = table
  if (format === 'markdown') {
    const escape = (cell: string): string => cell.replace(/\|/g, '\\|')
    return [
      `| ${headers.map(escape).join(' | ')} |`,
      `| ${headers.map(() => '---').join(' | ')} |`,
      ...rows.map(row => `| ${row.map(escape).join(' | ')} |`),
    ].join('\n')
  }
  const widths = headers.map((header, col) => Math.max(header.length, ...rows.map(row => (row[col] ?? '').length)))
  const line = (cells: string[]): string => cells.map((cell, col) => cell.padEnd(widths[col]!)).join('  ').trimEnd()
  return [line(headers), line(widths.map(width => '-'.repeat(width))), ...rows.map(line)].join('\n')
}

function formatOutcomes(outcomes: Record<string, number>): string {
  return Object.entries(outcomes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([outcome, count]) => `${count} ${outcome}`)
    .join(', ')
}

function shortSha(sha: string | null, dirty = false): string {
  return sha ? `${sha.slice(0, 7)}${dirty ? '+dirty' : ''}` : 'unknown'
}

function heading(format: RenderFormat, text: string): string {
  return format === 'markdown' ? `## ${text}` : text
}

export function renderReport(info: RunInfo | undefined, summary: RunSummary, format: RenderFormat = 'text'): string {
  const lines: string[] = []
  if (info) {
    lines.push(format === 'markdown' ? `# Run ${info.runId}` : `Run ${info.runId}`)
    lines.push(
      `${info.label ? `${info.label} | ` : ''}lane ${info.scenario.lane} | scenario ${info.scenarioHash} | ` +
        `coro ${shortSha(info.coroSha, info.coroDirty)} | harness ${shortSha(info.harnessSha, info.harnessDirty)}`,
    )
    if (Object.keys(info.scenario.models).length > 0) {
      lines.push(`models: ${Object.entries(info.scenario.models).map(([k, v]) => `${k}=${v}`).join(', ')}`)
    }
    lines.push('')
  }

  const table: Table = {
    headers: ['task', 'n', 'solved', 'pass@k', 'pass^k', 'cost', 'wall', 'agent', 'review wait', 'rework', 'judge', 'outcomes'],
    rows: summary.tasks.map(task => [
      task.taskId,
      String(task.attempts),
      `${task.solved}/${task.attempts}`,
      task.passAtK ? 'yes' : 'no',
      task.passPowK ? 'yes' : 'no',
      formatUsd(task.medianCostUsd),
      formatDuration(task.medianWallMs),
      formatDuration(task.medianAgentMs),
      formatDuration(task.medianReviewWaitMs),
      formatCount(task.medianReworkRuns),
      task.meanJudge !== undefined ? task.meanJudge.toFixed(2) : '-',
      formatOutcomes(task.outcomes),
    ]),
  }
  lines.push(heading(format, 'Per task (cost, times and rework are medians over the attempts)'))
  lines.push(renderTable(table, format))
  lines.push('')

  const o = summary.overall
  lines.push(heading(format, 'Overall'))
  const facts = [
    `solve rate ${formatPct(o.solveRate)} (${o.solved}/${o.attempts} attempts over ${o.tasks} tasks)`,
    `pass@k ${formatPct(o.passAtKRate)} of tasks solved at least once`,
    `pass^k ${formatPct(o.passPowKRate)} of tasks solved every time`,
    `cost per solved attempt ${o.costPerSolvedUsd === null ? 'n/a (none solved)' : formatUsd(o.costPerSolvedUsd)} (all spend ${formatUsd(o.totalCostUsd)}, failures included)`,
    `median wall ${formatDuration(o.medianWallMs)}, agent ${formatDuration(o.medianAgentMs)}, rework runs ${formatCount(o.medianReworkRuns)}`,
    ...(o.meanJudge !== undefined ? [`mean judge score ${o.meanJudge.toFixed(2)} / 5`] : []),
    `outcomes: ${formatOutcomes(o.outcomes) || 'none'}`,
  ]
  lines.push(...facts.map(fact => (format === 'markdown' ? `- ${fact}` : `  ${fact}`)))
  return lines.join('\n')
}

function formatDelta(def: MetricDef, delta: number | undefined): string {
  if (delta === undefined) return '-'
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : ''
  return `${sign}${def.format(Math.abs(delta))}`
}

function metricCells(comparison: MetricComparison): string[] {
  const def = METRICS[comparison.metric]
  return [
    comparison.a !== undefined ? def.format(comparison.a) : '-',
    comparison.b !== undefined ? def.format(comparison.b) : '-',
    formatDelta(def, comparison.delta),
    comparison.verdict,
  ]
}

export function renderComparison(
  runA: { id: string; label?: string },
  runB: { id: string; label?: string },
  comparison: Comparison,
  format: RenderFormat = 'text',
): string {
  const lines: string[] = []
  const name = (run: { id: string; label?: string }): string => (run.label ? `${run.id} (${run.label})` : run.id)
  lines.push(format === 'markdown' ? '# Comparison' : 'Comparison')
  lines.push(`A: ${name(runA)}`)
  lines.push(`B: ${name(runB)}`)
  lines.push('Deltas are B minus A. "noise" means the change is inside the spread between attempts of the same task.')
  lines.push('')

  const overallTable: Table = {
    headers: ['metric', 'A', 'B', 'delta', 'verdict'],
    rows: comparison.overall.metrics.map(m => [METRICS[m.metric].label, ...metricCells(m)]),
  }
  lines.push(heading(format, `Overall (average over ${comparison.overall.tasks} shared tasks)`))
  lines.push(renderTable(overallTable, format))
  lines.push('')

  for (const metricKey of COMPARE_METRICS) {
    const def = METRICS[metricKey]
    const table: Table = {
      headers: ['task', 'n (A/B)', 'A', 'B', 'delta', 'verdict'],
      rows: comparison.tasks.map(task => {
        const m = task.metrics.find(entry => entry.metric === metricKey)!
        return [task.taskId, `${task.attemptsA}/${task.attemptsB}`, ...metricCells(m)]
      }),
    }
    lines.push(heading(format, `By task: ${def.label}`))
    lines.push(renderTable(table, format))
    lines.push('')
  }

  if (comparison.onlyInA.length > 0) lines.push(`Only in A (not compared): ${comparison.onlyInA.join(', ')}`)
  if (comparison.onlyInB.length > 0) lines.push(`Only in B (not compared): ${comparison.onlyInB.join(', ')}`)
  return lines.join('\n').trimEnd()
}

export function renderHistory(
  rows: readonly HistoryRow[],
  options: { metric: MetricKey; task?: string },
  format: RenderFormat = 'text',
): string {
  const def = METRICS[options.metric]
  const table: Table = {
    headers: ['run', 'label', 'coro', 'n', 'solved', def.label, 'change'],
    rows: rows.map(row => [
      row.runId,
      row.label,
      shortSha(row.coroSha),
      String(row.attempts),
      formatPct(row.solveRate),
      row.value !== undefined ? def.format(row.value) : '-',
      row.delta !== undefined ? formatDelta(def, row.delta) : '',
    ]),
  }
  const title = `History of ${def.label}${options.task ? ` for ${options.task}` : ' over all tasks'} (mean per run, oldest first)`
  return [heading(format, title), renderTable(table, format)].join('\n')
}
