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
    for (const entry of snapshot.toolLedger ?? []) {
      if (!entry.success) {
        fails.set(entry.toolName, (fails.get(entry.toolName) ?? 0) + 1)
      }
      if (isSearchTool(entry.toolName)) searchStreak += 1
      else searchStreak = 0
      if (searchStreak >= 12) found.add('search-loop')
      if (isWriteTool(entry.toolName)) wrote = true
      if (isVerifyTool(entry.toolName)) tested = true
    }
    for (const count of fails.values()) {
      if (count >= 3) found.add('same-tool-fail')
    }
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
    return {
      findingId: finding.id,
      title: finding.title,
      retrospectiveJobId,
      predictedMetric: metric,
      score: 'unverifiable',
      reason: `Cannot compute ${metric.name} on this window.`,
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

export function metricValue(jobs: ReadonlyArray<Job>, name: string): number | undefined {
  const trimmed = name.trim()
  if (!trimmed) return undefined
  if (trimmed === 'costUsd') {
    return jobs.reduce((sum, job) => sum + (job.tokenUsage?.totalCostUsd ?? 0), 0)
  }
  if (trimmed === 'escalationCount') {
    return jobs.filter(isEscalated).length
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
