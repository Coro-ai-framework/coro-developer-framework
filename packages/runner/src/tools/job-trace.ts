// ── Retrospective evidence tools ─────────────────────────────────────────────
//
// Mechanical clustering and distilled traces. The analyst names the
// behaviour; these tools do the grouping so findings are not invented
// from log tails. Retrospective jobs only — ordinary agents never see
// another job's internals.

import { JobType, type Job } from '@coro-ai/cloud-protocol'
import { normalizeErrorClass } from '../jobs/phase-observability'
import {
  RETROSPECTIVE_DEFAULT_WINDOW,
  RETROSPECTIVE_MAX_WINDOW,
  RETROSPECTIVE_MIN_WINDOW,
  normalizeRetrospectiveWindow,
  summarizeRetrospective,
  type PredictedMetric,
  type RetrospectiveFinding,
} from '../jobs/retrospective'
import {
  JOB_LIST_MAX_LIMIT,
  aggregatePhaseRuns,
  buildJobReport,
  clamp,
  isEscalated,
  median,
  phaseRunContext,
  toolHistogram,
} from './job-history'
import { buildSanitizer, type Sanitizer } from './sanitize'
import { assertRetrospectiveJob } from './retrospective'
import type { ToolContext } from './types'

export const TRACE_EVENT_CAP = 40

export type TraceAntiPattern =
  | 'same-tool-fail'
  | 'search-loop'
  | 'verify-skip'
  | 'zero-cost-park'
  | 'cache-blowup'
  | 'session-reset'

export interface TraceEvent {
  phase: string
  kind: 'tool-fail' | 'park' | 'rework' | 'cache-blowup'
  detail: string
  toolName?: string
  errorClass?: string
}

export interface ClusterCount {
  key: string
  count: number
  jobIds: string[]
  sample?: string
}

export type RemedyScore = 'still-firing' | 'reduced' | 'gone' | 'regressed' | 'unverifiable'

export interface PriorRemedyScore {
  findingId: string
  title: string
  retrospectiveJobId: string
  predictedMetric?: PredictedMetric
  score: RemedyScore
  reason: string
  currentValue?: number
}

export interface ClusterWindowArgs {
  limit?: number
  since?: string
}

export async function clusterWindow(
  args: ClusterWindowArgs,
  ctx: ToolContext,
): Promise<{
  window: {
    jobCount: number
    medianCostUsd: number
    medianInputTokens: number
    workflowPaths: string[]
  }
  errorClasses: ClusterCount[]
  insights: ClusterCount[]
  toolFailures: ClusterCount[]
  costOutliers: Array<{ jobId: string; workflowPath: string; costUsd: number; median: number; ratio: number }>
  tokenOutliers: Array<{ jobId: string; workflowPath: string; inputTokens: number; median: number; ratio: number }>
  siblings: Array<{ workflowPath: string; succeeded: string[]; failed: string[] }>
  priorRemedies: PriorRemedyScore[]
}> {
  assertRetrospectiveJob(ctx, 'cluster_window')

  const requested = args.limit
    ?? normalizeRetrospectiveWindow(numberOr(ctx.job.params['jobWindow'], RETROSPECTIVE_DEFAULT_WINDOW))
  const limit = clamp(requested, RETROSPECTIVE_MIN_WINDOW, Math.min(RETROSPECTIVE_MAX_WINDOW, JOB_LIST_MAX_LIMIT))

  const all = await ctx.stateBackend.listJobs()
  const sanitizer = buildSanitizer(all, ctx.settings, ctx.tenantContext.tenantId)
  const sinceMs = parseSince(args.since)

  const implementation = all.filter(job => {
    if (job.type !== JobType.Job) return false
    if (job.id === ctx.job.id) return false
    if (sinceMs !== null && Date.parse(job.createdAt) < sinceMs) return false
    return true
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

  const windowJobs = implementation.slice(0, limit)
  const costs = windowJobs.map(job => job.tokenUsage?.totalCostUsd ?? 0)
  const inputs = windowJobs.map(job => job.tokenUsage?.inputTokens ?? 0)
  const medianCost = median(costs)
  const medianInput = median(inputs)

  const errorClasses = new Map<string, ClusterCount>()
  const insights = new Map<string, ClusterCount>()
  const toolFailures = new Map<string, ClusterCount>()

  for (const job of windowJobs) {
    if (job.escalationMessage) {
      bump(errorClasses, normalizeErrorClass(sanitizer.apply(job.escalationMessage)), job.id, job.escalationMessage)
    }
    for (const insight of job.insights ?? []) {
      bump(insights, insight.category || 'uncategorised', job.id, insight.summary)
    }
    for (const usage of job.phaseUsage ?? []) {
      for (const entry of usage.toolLedger ?? []) {
        if (entry.success) continue
        const errorClass = entry.errorClass ?? 'error'
        bump(toolFailures, `${entry.toolName}|${errorClass}`, job.id, errorClass)
        bump(errorClasses, errorClass, job.id, errorClass)
      }
    }
  }

  const costByWorkflow = medianBy(windowJobs, job => job.tokenUsage?.totalCostUsd ?? 0)
  const tokenByWorkflow = medianBy(windowJobs, job => job.tokenUsage?.inputTokens ?? 0)

  const costOutliers = windowJobs.flatMap(job => {
    const medianForPath = costByWorkflow.get(job.workflowPath) ?? medianCost
    const costUsd = job.tokenUsage?.totalCostUsd ?? 0
    if (medianForPath <= 0 || costUsd < medianForPath * 2) return []
    return [{
      jobId: job.id,
      workflowPath: job.workflowPath,
      costUsd: round4(costUsd),
      median: round4(medianForPath),
      ratio: round4(costUsd / medianForPath),
    }]
  })

  const tokenOutliers = windowJobs.flatMap(job => {
    const medianForPath = tokenByWorkflow.get(job.workflowPath) ?? medianInput
    const inputTokens = job.tokenUsage?.inputTokens ?? 0
    if (medianForPath <= 0 || inputTokens < medianForPath * 2) return []
    return [{
      jobId: job.id,
      workflowPath: job.workflowPath,
      inputTokens,
      median: Math.round(medianForPath),
      ratio: round4(inputTokens / medianForPath),
    }]
  })

  const siblingMap = new Map<string, { succeeded: string[]; failed: string[] }>()
  for (const job of windowJobs) {
    const row = siblingMap.get(job.workflowPath) ?? { succeeded: [], failed: [] }
    if (isEscalated(job) || job.status === 'failed') row.failed.push(job.id)
    else if (job.status === 'complete') row.succeeded.push(job.id)
    siblingMap.set(job.workflowPath, row)
  }

  return {
    window: {
      jobCount: windowJobs.length,
      medianCostUsd: round4(medianCost),
      medianInputTokens: Math.round(medianInput),
      workflowPaths: [...new Set(windowJobs.map(job => job.workflowPath))],
    },
    errorClasses: ranked(errorClasses),
    insights: ranked(insights),
    toolFailures: ranked(toolFailures),
    costOutliers,
    tokenOutliers,
    siblings: [...siblingMap.entries()].map(([workflowPath, row]) => ({ workflowPath, ...row })),
    priorRemedies: scorePriorRemedies(all, windowJobs),
  }
}

export async function getJobTraceSummary(
  args: { jobId: string; raw?: boolean },
  ctx: ToolContext,
): Promise<{
  jobId: string
  antiPatterns: TraceAntiPattern[]
  events: TraceEvent[]
  toolHistogram: ReturnType<typeof toolHistogram>
  provenance?: Job['intelligenceProvenance']
  phaseRuns: ReturnType<typeof buildJobReport>['phaseRuns']
}> {
  assertRetrospectiveJob(ctx, 'get_job_trace_summary')

  const jobId = args.jobId?.trim()
  if (!jobId) throw new Error('get_job_trace_summary requires a jobId.')

  const job = await ctx.stateBackend.getJob(jobId)
  if (!job) throw new Error(`get_job_trace_summary: no job found with id "${jobId}".`)

  const all = await ctx.stateBackend.listJobs()
  const sanitizer = args.raw === true
    ? null
    : buildSanitizer(all, ctx.settings, ctx.tenantContext.tenantId)
  const report = buildJobReport(job, sanitizer)
  const events = distillEvents(job, sanitizer)
  return {
    jobId,
    antiPatterns: detectAntiPatterns(job),
    events,
    toolHistogram: report.toolHistogram,
    ...(report.provenance ? { provenance: report.provenance } : {}),
    phaseRuns: report.phaseRuns,
  }
}

export function detectAntiPatterns(job: Job): TraceAntiPattern[] {
  const found = new Set<TraceAntiPattern>()
  const usage = job.phaseUsage ?? []

  for (const snapshot of usage) {
    const fails = new Map<string, number>()
    let searchStreak = 0
    let wrote = false
    let tested = false
    let sessionResets = 0
    for (const entry of snapshot.toolLedger ?? []) {
      if (!entry.success) {
        fails.set(entry.toolName, (fails.get(entry.toolName) ?? 0) + 1)
      }
      if (isSearchTool(entry.toolName)) searchStreak += 1
      else searchStreak = 0
      if (searchStreak >= 12) found.add('search-loop')
      if (isWriteTool(entry.toolName)) wrote = true
      if (isVerifyTool(entry.toolName)) tested = true
      if (isSessionReset(entry.toolName)) sessionResets += 1
    }
    for (const count of fails.values()) {
      if (count >= 3) found.add('same-tool-fail')
    }
    // One reset per run is the documented way to start a work item with a
    // clean context. Two in the same run is the agent throwing away its own
    // progress — the coherence collapse that phase counts cannot show.
    if (sessionResets >= 2) found.add('session-reset')
    if (snapshot.phase === 'coding' && wrote && !tested) found.add('verify-skip')
    if ((snapshot.costUsd ?? 0) === 0 && snapshot.parkReason) found.add('zero-cost-park')
    if ((snapshot.cacheReadInputTokens ?? 0) > Math.max(1, snapshot.inputTokens ?? 0) * 2) {
      found.add('cache-blowup')
    }
  }

  return [...found]
}

export function scorePriorRemedies(
  allJobs: ReadonlyArray<Job>,
  currentWindow: ReadonlyArray<Job>,
): PriorRemedyScore[] {
  const retros = allJobs
    .filter(job => job.type === JobType.Retrospective)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 5)

  const scores: PriorRemedyScore[] = []
  for (const retro of retros) {
    const summary = summarizeRetrospective(retro)
    const shipped = summary.outcomes.filter(outcome => outcome.destination !== 'none')
    if (shipped.length === 0 && summary.findings.length === 0) continue

    for (const finding of summary.findings) {
      const outcome = summary.outcomes.find(item => item.findingId === finding.id)
      if (outcome && outcome.destination === 'none') continue
      if (summary.outcomes.length > 0 && !outcome) continue

      scores.push(scoreFinding(finding, retro.id, currentWindow))
    }
  }
  return scores
}

function scoreFinding(
  finding: RetrospectiveFinding,
  retrospectiveJobId: string,
  currentWindow: ReadonlyArray<Job>,
): PriorRemedyScore {
  const metric = finding.predictedMetric
  if (!metric) {
    return {
      findingId: finding.id,
      title: finding.title,
      retrospectiveJobId,
      score: 'unverifiable',
      reason: 'Prior finding had no predictedMetric — treat as unverified, not done.',
    }
  }

  const currentValue = metricValue(currentWindow, metric.name)
  if (currentValue === undefined) {
    // A computable name with no matches scores 0, so reaching here means the
    // name itself is one the scorer never understood — say which part, or the
    // next analyst re-files the finding with the same unscoreable metric.
    const why = metricNameError(metric.name) ?? 'unrecognised metric name'
    return {
      findingId: finding.id,
      title: finding.title,
      retrospectiveJobId,
      predictedMetric: metric,
      score: 'unverifiable',
      reason:
        `Cannot compute "${metric.name}" (${why}), so this remedy was never scored. ` +
        'Treat it as unverified and re-file with a supported metric.',
    }
  }

  let score: RemedyScore
  let reason: string
  if (metric.direction === 'eliminate') {
    score = currentValue === 0 ? 'gone' : 'still-firing'
    reason = currentValue === 0
      ? `${metric.name} is 0 in this window.`
      : `${metric.name} is still ${currentValue}.`
  } else if (metric.baseline === undefined) {
    score = 'unverifiable'
    reason = `No baseline recorded for ${metric.name}.`
  } else if (metric.direction === 'decrease') {
    if (currentValue <= metric.baseline * 0.5) {
      score = currentValue === 0 ? 'gone' : 'reduced'
      reason = `${metric.name} fell from ${metric.baseline} to ${currentValue}.`
    } else if (currentValue > metric.baseline * 1.1) {
      score = 'regressed'
      reason = `${metric.name} rose from ${metric.baseline} to ${currentValue}.`
    } else if (currentValue < metric.baseline) {
      score = 'reduced'
      reason = `${metric.name} fell from ${metric.baseline} to ${currentValue}.`
    } else {
      score = 'still-firing'
      reason = `${metric.name} is ${currentValue} (baseline ${metric.baseline}).`
    }
  } else {
    // increase — rare; treat symmetrically
    if (currentValue >= metric.baseline * 1.5) {
      score = 'reduced'
      reason = `${metric.name} rose from ${metric.baseline} to ${currentValue}.`
    } else if (currentValue < metric.baseline * 0.9) {
      score = 'regressed'
      reason = `${metric.name} fell from ${metric.baseline} to ${currentValue}.`
    } else {
      score = 'still-firing'
      reason = `${metric.name} is ${currentValue} (baseline ${metric.baseline}).`
    }
  }

  return {
    findingId: finding.id,
    title: finding.title,
    retrospectiveJobId,
    predictedMetric: metric,
    score,
    reason,
    currentValue,
  }
}

// ── Metric vocabulary ────────────────────────────────────────────────────────
//
// A `predictedMetric` is only worth recording if the next retrospective can
// compute it. Every name below is a key the analyst can read straight off
// `cluster_window` output, so the baseline it records and the value the next
// run scores are the same number by construction — an analyst that invents a
// name gets `unverifiable` a month later, which is exactly the open loop this
// vocabulary closes.
//
// The prefixed forms count *structural* fields (insight category, tool name,
// ledger error class). Free-text signals like escalation messages are
// deliberately absent: `normalizeErrorClass` rewrites paths and digits, and
// sanitisation aliases repo slugs before that runs, so the same failure can
// normalise differently between two windows.

export const SCALAR_METRICS = ['costUsd', 'escalationCount'] as const
export const PHASE_METRIC_FIELDS = ['runs', 'reworkRuns', 'reworkCostUsd'] as const
export const METRIC_PREFIXES = ['insight', 'toolFail'] as const

export const METRIC_VOCABULARY: ReadonlyArray<{ form: string; describes: string }> = [
  { form: 'costUsd', describes: 'Total cost across the window.' },
  { form: 'escalationCount', describes: 'Jobs that escalated.' },
  { form: '<phase>.runs', describes: 'Attributed runs of a phase, e.g. `coding.runs`.' },
  { form: '<phase>.reworkRuns', describes: 'Rework runs beyond work-item and checkpoint-resume runs.' },
  { form: '<phase>.reworkCostUsd', describes: 'Dollars spent on those rework runs.' },
  { form: 'insight:<category>', describes: 'Insights in a category — the `key` of a `cluster_window.insights` row.' },
  { form: 'toolFail:<tool>', describes: 'Failed calls of a tool across the window.' },
  { form: 'toolFail:<tool>|<errorClass>', describes: 'The `key` of a `cluster_window.toolFailures` row, verbatim.' },
]

/**
 * Whether `metricValue` can compute this name.
 *
 * Shape only: `coding.runs` and `nosuchphase.runs` both pass, because the
 * phases and categories a future window will contain are not knowable when
 * the finding is written. What this rejects is a name whose *form* the
 * scorer has never understood — the failure that made every metric in the
 * 2026-08-25 run unscoreable.
 */
export function isSupportedMetricName(name: string): boolean {
  return metricNameError(name) === undefined
}

/** Why this metric name is unusable, or `undefined` when it is fine. */
export function metricNameError(name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return 'metric name is empty'
  if ((SCALAR_METRICS as ReadonlyArray<string>).includes(trimmed)) return undefined

  const colon = trimmed.indexOf(':')
  if (colon > 0) {
    const prefix = trimmed.slice(0, colon)
    if (!(METRIC_PREFIXES as ReadonlyArray<string>).includes(prefix)) {
      return `unknown metric prefix "${prefix}:"`
    }
    return trimmed.slice(colon + 1).trim()
      ? undefined
      : `"${prefix}:" needs a key after the colon`
  }

  const dot = trimmed.indexOf('.')
  if (dot <= 0) return `"${trimmed}" is not a metric name the scorer understands`
  const field = trimmed.slice(dot + 1)
  if (!(PHASE_METRIC_FIELDS as ReadonlyArray<string>).includes(field)) {
    return `"${field}" is not a phase metric — expected one of ${PHASE_METRIC_FIELDS.join(', ')}`
  }
  return undefined
}

/** The vocabulary as prompt-ready lines, so error messages teach the fix. */
export function describeMetricVocabulary(): string {
  return METRIC_VOCABULARY.map(entry => `  ${entry.form} — ${entry.describes}`).join('\n')
}

export function metricValue(jobs: ReadonlyArray<Job>, name: string): number | undefined {
  const trimmed = name.trim()
  if (!trimmed) return undefined
  if (trimmed === 'costUsd') {
    return jobs.reduce((sum, job) => sum + (job.tokenUsage?.totalCostUsd ?? 0), 0)
  }
  if (trimmed === 'escalationCount') {
    return jobs.filter(isEscalated).length
  }

  const colon = trimmed.indexOf(':')
  if (colon > 0) {
    const prefix = trimmed.slice(0, colon)
    const key = trimmed.slice(colon + 1).trim()
    if (!key) return undefined
    if (prefix === 'insight') return countInsights(jobs, key)
    if (prefix === 'toolFail') return countToolFailures(jobs, key)
    return undefined
  }

  const dot = trimmed.indexOf('.')
  if (dot <= 0) return undefined
  const phase = trimmed.slice(0, dot)
  const field = trimmed.slice(dot + 1)
  if (field !== 'reworkRuns' && field !== 'reworkCostUsd' && field !== 'runs') return undefined

  return jobs.reduce((sum, job) => {
    const aggregated = aggregatePhaseRuns(job.phaseUsage ?? [], phaseRunContext(job))
    const row = aggregated.find(item => item.phase === phase)
    if (!row) return sum
    if (field === 'reworkRuns') return sum + row.reworkRuns
    if (field === 'reworkCostUsd') return sum + row.reworkCostUsd
    return sum + row.runs
  }, 0)
}

/** Counts the same way `cluster_window` does, so a cluster row is a baseline. */
function countInsights(jobs: ReadonlyArray<Job>, category: string): number {
  const wanted = category.toLowerCase()
  let count = 0
  for (const job of jobs) {
    for (const insight of job.insights ?? []) {
      if ((insight.category || 'uncategorised').toLowerCase() === wanted) count += 1
    }
  }
  return count
}

/** `<tool>` counts every failure of that tool; `<tool>|<errorClass>` narrows it. */
function countToolFailures(jobs: ReadonlyArray<Job>, key: string): number {
  const bar = key.indexOf('|')
  const toolName = (bar >= 0 ? key.slice(0, bar) : key).trim().toLowerCase()
  const errorClass = bar >= 0 ? key.slice(bar + 1).trim().toLowerCase() : ''
  if (!toolName) return 0

  let count = 0
  for (const job of jobs) {
    for (const usage of job.phaseUsage ?? []) {
      for (const entry of usage.toolLedger ?? []) {
        if (entry.success) continue
        if (entry.toolName.toLowerCase() !== toolName) continue
        if (errorClass && (entry.errorClass ?? 'error').toLowerCase() !== errorClass) continue
        count += 1
      }
    }
  }
  return count
}

function distillEvents(job: Job, sanitizer: Sanitizer | null): TraceEvent[] {
  const scrub = (text: string) => (sanitizer ? sanitizer.apply(text) : text)
  const events: TraceEvent[] = []
  const attributed = aggregatePhaseRuns(job.phaseUsage ?? [], phaseRunContext(job))

  for (const snapshot of job.phaseUsage ?? []) {
    if (snapshot.parkReason) {
      events.push({
        phase: snapshot.phase,
        kind: 'park',
        detail: scrub(snapshot.parkReason),
      })
    }
    if ((snapshot.cacheReadInputTokens ?? 0) > Math.max(1, snapshot.inputTokens ?? 0) * 2) {
      events.push({
        phase: snapshot.phase,
        kind: 'cache-blowup',
        detail: `cacheRead ${snapshot.cacheReadInputTokens} vs input ${snapshot.inputTokens}`,
      })
    }
    for (const entry of snapshot.toolLedger ?? []) {
      if (entry.success) continue
      events.push({
        phase: snapshot.phase,
        kind: 'tool-fail',
        toolName: entry.toolName,
        errorClass: entry.errorClass,
        detail: `${entry.toolName} failed${entry.errorClass ? ` (${entry.errorClass})` : ''}`,
      })
    }
  }

  for (const phase of attributed) {
    if (phase.reworkRuns > 0) {
      events.push({
        phase: phase.phase,
        kind: 'rework',
        detail: `${phase.reworkRuns} rework run(s), $${phase.reworkCostUsd}`,
      })
    }
  }

  return events.slice(-TRACE_EVENT_CAP)
}

function bump(map: Map<string, ClusterCount>, key: string, jobId: string, sample: string): void {
  const existing = map.get(key)
  if (!existing) {
    map.set(key, { key, count: 1, jobIds: [jobId], sample: sample.slice(0, 160) })
    return
  }
  existing.count += 1
  if (!existing.jobIds.includes(jobId)) existing.jobIds.push(jobId)
}

function ranked(map: Map<string, ClusterCount>): ClusterCount[] {
  return [...map.values()].sort((a, b) => b.count - a.count || b.jobIds.length - a.jobIds.length)
}

function medianBy(jobs: ReadonlyArray<Job>, value: (job: Job) => number): Map<string, number> {
  const grouped = new Map<string, number[]>()
  for (const job of jobs) {
    const list = grouped.get(job.workflowPath) ?? []
    list.push(value(job))
    grouped.set(job.workflowPath, list)
  }
  const out = new Map<string, number>()
  for (const [path, values] of grouped) out.set(path, median(values))
  return out
}

function isSearchTool(name: string): boolean {
  return name === 'Grep' || name === 'Glob' || name === 'Read'
}

function isWriteTool(name: string): boolean {
  return name === 'Edit' || name === 'Write'
}

function isVerifyTool(name: string): boolean {
  return name === 'Bash' || name.startsWith('mcp__coro__') && name.includes('test')
}

/** Matched on the suffix so the MCP prefix is not load-bearing. */
function isSessionReset(name: string): boolean {
  return name === 'request_new_session' || name.endsWith('__request_new_session')
}

function parseSince(since?: string): number | null {
  if (!since?.trim()) return null
  const parsed = Date.parse(since)
  if (!Number.isFinite(parsed)) {
    throw new Error(`cluster_window: "since" must be an ISO timestamp, got "${since}".`)
  }
  return parsed
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}
