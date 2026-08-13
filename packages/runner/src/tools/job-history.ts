// ── Cross-job history access ─────────────────────────────────────────────────
//
// Read-only views over the install's own job records, exposed to the
// retrospective analyst through `list_jobs`, `get_job_report`, and
// `get_job_log_excerpts`.
//
// Every other agent sees exactly one job — its own. The retrospective needs
// the opposite: enough shape across many jobs to spot systemic problems
// ("the coding phase ran 4+ times in half of last week's runs"), without
// dragging whole transcripts into the context window. So the reports here
// are aggregates, not dumps:
//
//   * `phaseUsage` collapses to one row per phase with a `runs` count —
//     that count *is* the loop signal, since the runner appends a fresh
//     snapshot every time a phase executes.
//   * Logs are filtered to error-ish lines and capped.
//
// Output is sanitised by default (see `./sanitize`). Callers that need the
// real identifiers for local-only reasoning pass `raw: true`; anything
// leaving the machine is re-validated at the publishing boundary.

import { JobType, type Job, type PhaseUsage } from '@coro-ai/cloud-protocol'
import { buildSanitizer, type Sanitizer } from './sanitize'
import { assertRetrospectiveJob } from './retrospective'
import type { ToolContext } from './types'

export const JOB_LIST_DEFAULT_LIMIT = 20
export const JOB_LIST_MAX_LIMIT = 100
export const LOG_EXCERPT_DEFAULT_LIMIT = 100
export const LOG_EXCERPT_MAX_LIMIT = 200
const LOG_LINE_MAX_CHARS = 400

/**
 * Lines worth showing an analyst by default: runner/executor error and
 * warning markers, rate-limit parks, escalations, and the per-phase
 * tool-use summary (useful for spotting a tool that keeps failing).
 */
export const DEFAULT_LOG_EXCERPT_PATTERN =
  '\\[(error|warning|rate.?limit|escalat|control|session-reset)|tool_use counts|Error:|failed'

/** Job types the analyst may enumerate. */
export type JobHistoryScope = 'job' | 'retrospective'

export interface JobHistoryEntry {
  id: string
  status: string
  /** Phase the job was in when it last stopped. */
  phase: string
  workflowPath: string
  repo: string
  createdAt: string
  durationMs: number
  costUsd: number
  escalated: boolean
  workItemCount: number
  /** Highest per-work-item loop count — the evaluator's rework signal. */
  maxLoopCount: number
  /** Phases that executed more than once, with their run counts. */
  loopedPhases: Array<{ phase: string; runs: number }>
}

export interface PhaseRunAggregate {
  phase: string
  /** Number of times this phase executed. > 1 means the job looped back. */
  runs: number
  costUsd: number
  durationMs: number
  turns: number
  models: string[]
}

export interface JobReport {
  id: string
  type: string
  status: string
  phase: string
  workflowPath: string
  repo: string
  createdAt: string
  updatedAt: string
  durationMs: number
  costUsd: number
  escalated: boolean
  escalationMessage?: string
  /** How many times the job parked on a provider rate limit. */
  rateLimitRetries: number
  workItems: Array<{ name: string; status: string; loopCount: number }>
  phases: PhaseRunAggregate[]
  loopedPhases: Array<{ phase: string; runs: number }>
  insights: Array<{ category: string; summary: string; suggestion?: string; status: string }>
  prs: Array<{ workItem: string; openedAt: string; mergedAt?: string; timeToMergeMs?: number }>
  artifacts: Array<{ id: string; phase: string; kind: string; title: string }>
  workflowSwitches: Array<{ from: string; to: string; reason: string }>
}

// ── list_jobs ─────────────────────────────────────────────────────────────────

export interface ListJobHistoryArgs {
  limit?: number
  status?: string
  /** ISO timestamp; only jobs created at or after this are returned. */
  since?: string
  scope?: JobHistoryScope
}

export async function listJobHistory(
  args: ListJobHistoryArgs,
  ctx: ToolContext,
): Promise<{ scope: JobHistoryScope; total: number; returned: number; jobs: JobHistoryEntry[] }> {
  assertRetrospectiveJob(ctx, 'list_jobs')

  const scope = args.scope ?? 'job'
  const wantedType = scope === 'retrospective' ? JobType.Retrospective : JobType.Job
  const all = await ctx.stateBackend.listJobs()
  const sanitizer = buildSanitizer(all, ctx.settings, ctx.tenantContext.tenantId)

  const sinceMs = parseSince(args.since)
  const matching = all.filter(job => {
    if (job.type !== wantedType) return false
    if (job.id === ctx.job.id) return false
    if (args.status && job.status !== args.status) return false
    if (sinceMs !== null && Date.parse(job.createdAt) < sinceMs) return false
    return true
  })

  const limit = clamp(args.limit ?? JOB_LIST_DEFAULT_LIMIT, 1, JOB_LIST_MAX_LIMIT)
  // `listJobs` returns newest-first from every backend; re-sort defensively
  // so the window is well-defined regardless of implementation.
  const page = matching
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)

  return {
    scope,
    total: matching.length,
    returned: page.length,
    jobs: page.map(job => summarizeJob(job, sanitizer)),
  }
}

export function summarizeJob(job: Job, sanitizer: Sanitizer): JobHistoryEntry {
  const phases = aggregatePhaseRuns(job.phaseUsage ?? [])
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    workflowPath: job.workflowPath,
    repo: sanitizer.repoAlias(jobRepo(job)),
    createdAt: job.createdAt,
    durationMs: elapsedMs(job.createdAt, job.updatedAt),
    costUsd: round(job.tokenUsage?.totalCostUsd ?? 0, 4),
    escalated: isEscalated(job),
    workItemCount: job.workItems?.length ?? 0,
    maxLoopCount: (job.workItems ?? []).reduce((max, item) => Math.max(max, item.loopCount ?? 0), 0),
    loopedPhases: loopedPhases(phases),
  }
}

// ── get_job_report ────────────────────────────────────────────────────────────

export async function buildJobReportById(
  args: { jobId: string; raw?: boolean },
  ctx: ToolContext,
): Promise<JobReport> {
  assertRetrospectiveJob(ctx, 'get_job_report')

  const jobId = args.jobId?.trim()
  if (!jobId) throw new Error('get_job_report requires a jobId.')

  const job = await ctx.stateBackend.getJob(jobId)
  if (!job) throw new Error(`get_job_report: no job found with id "${jobId}".`)

  // Sanitise against every identifier this install knows, not just this
  // job's own — an escalation message can name a sibling repository.
  const all = await ctx.stateBackend.listJobs()
  const sanitizer = buildSanitizer(all, ctx.settings, ctx.tenantContext.tenantId)
  return buildJobReport(job, args.raw === true ? null : sanitizer)
}

/**
 * Assemble the report. Pass `sanitizer: null` to keep raw identifiers
 * (local-only reasoning); pass a sanitizer for anything that may be
 * quoted into public text.
 */
export function buildJobReport(job: Job, sanitizer: Sanitizer | null): JobReport {
  const scrub = (text: string): string => (sanitizer ? sanitizer.apply(text) : text)
  const phases = aggregatePhaseRuns(job.phaseUsage ?? [])
  const escalationMessage = job.escalationMessage ? scrub(job.escalationMessage) : undefined

  return {
    id: job.id,
    type: job.type,
    status: job.status,
    phase: job.phase,
    workflowPath: job.workflowPath,
    repo: sanitizer ? sanitizer.repoAlias(jobRepo(job)) : jobRepo(job),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    durationMs: elapsedMs(job.createdAt, job.updatedAt),
    costUsd: round(job.tokenUsage?.totalCostUsd ?? 0, 4),
    escalated: isEscalated(job),
    ...(escalationMessage ? { escalationMessage } : {}),
    rateLimitRetries: job.rateLimitInfo?.retryAttempt ?? 0,
    workItems: (job.workItems ?? []).map(item => ({
      name: scrub(item.name),
      status: item.status,
      loopCount: item.loopCount ?? 0,
    })),
    phases,
    loopedPhases: loopedPhases(phases),
    insights: (job.insights ?? []).map(insight => ({
      category: insight.category,
      summary: scrub(insight.editedSummary ?? insight.summary),
      ...(insight.suggestion ? { suggestion: scrub(insight.editedSuggestion ?? insight.suggestion) } : {}),
      status: insight.status ?? 'pending',
    })),
    prs: (job.prMappings ?? []).map(pr => ({
      workItem: scrub(pr.workItem),
      openedAt: pr.openedAt,
      ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
      ...(pr.mergedAt ? { timeToMergeMs: elapsedMs(pr.openedAt, pr.mergedAt) } : {}),
    })),
    artifacts: (job.artifacts ?? []).map(artifact => ({
      id: artifact.id,
      phase: artifact.phase,
      kind: artifact.kind,
      title: scrub(artifact.title),
    })),
    workflowSwitches: (job.workflowPathHistory ?? []).map(entry => ({
      from: entry.from,
      to: entry.to,
      reason: scrub(entry.reason),
    })),
  }
}

// ── get_job_log_excerpts ──────────────────────────────────────────────────────

export interface LogExcerptArgs {
  jobId: string
  pattern?: string
  limit?: number
  raw?: boolean
}

export async function getJobLogExcerpts(
  args: LogExcerptArgs,
  ctx: ToolContext,
): Promise<{ jobId: string; pattern: string; matched: number; returned: number; lines: string[] }> {
  assertRetrospectiveJob(ctx, 'get_job_log_excerpts')

  const jobId = args.jobId?.trim()
  if (!jobId) throw new Error('get_job_log_excerpts requires a jobId.')

  const job = await ctx.stateBackend.getJob(jobId)
  if (!job) throw new Error(`get_job_log_excerpts: no job found with id "${jobId}".`)

  const pattern = args.pattern?.trim() || DEFAULT_LOG_EXCERPT_PATTERN
  let re: RegExp
  try {
    re = new RegExp(pattern, 'i')
  } catch (err) {
    throw new Error(`get_job_log_excerpts: invalid pattern "${pattern}" — ${(err as Error).message}`)
  }

  const all = await ctx.stateBackend.getLog(jobId)
  const matches = all.filter(line => re.test(line))
  const limit = clamp(args.limit ?? LOG_EXCERPT_DEFAULT_LIMIT, 1, LOG_EXCERPT_MAX_LIMIT)
  // Keep the tail: the lines nearest a failure explain it best.
  const tail = matches.slice(-limit)

  const sanitizer = args.raw === true
    ? null
    : buildSanitizer(await ctx.stateBackend.listJobs(), ctx.settings, ctx.tenantContext.tenantId)

  return {
    jobId,
    pattern,
    matched: matches.length,
    returned: tail.length,
    lines: tail.map(line => {
      const truncated = line.length > LOG_LINE_MAX_CHARS ? `${line.slice(0, LOG_LINE_MAX_CHARS)}…` : line
      return sanitizer ? sanitizer.apply(truncated) : truncated
    }),
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Collapse the per-execution `phaseUsage` snapshots into one row per
 * phase. The `runs` count is the loop signal: the runner appends a
 * snapshot every time a phase executes, so a phase with 4 rows was
 * re-entered 3 times.
 */
export function aggregatePhaseRuns(phaseUsage: ReadonlyArray<PhaseUsage>): PhaseRunAggregate[] {
  const byPhase = new Map<string, PhaseRunAggregate>()
  for (const usage of phaseUsage) {
    const existing = byPhase.get(usage.phase)
    const entry: PhaseRunAggregate = existing ?? {
      phase: usage.phase,
      runs: 0,
      costUsd: 0,
      durationMs: 0,
      turns: 0,
      models: [],
    }
    entry.runs += 1
    entry.costUsd += usage.costUsd ?? 0
    entry.durationMs += usage.durationMs ?? 0
    entry.turns += usage.numTurns ?? 0
    if (usage.model && !entry.models.includes(usage.model)) entry.models.push(usage.model)
    byPhase.set(usage.phase, entry)
  }
  return Array.from(byPhase.values()).map(entry => ({
    ...entry,
    costUsd: round(entry.costUsd, 4),
  }))
}

function loopedPhases(phases: ReadonlyArray<PhaseRunAggregate>): Array<{ phase: string; runs: number }> {
  return phases
    .filter(phase => phase.runs > 1)
    .map(phase => ({ phase: phase.phase, runs: phase.runs }))
}

function jobRepo(job: Job): string {
  const slug = job.params?.['repoSlug'] ?? job.params?.['repo']
  return typeof slug === 'string' ? slug : ''
}

function isEscalated(job: Job): boolean {
  return Boolean(job.escalationMessage) || job.status === 'escalated'
}

function elapsedMs(from: string, to: string): number {
  const start = Date.parse(from)
  const end = Date.parse(to)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, end - start)
}

function parseSince(since?: string): number | null {
  if (!since?.trim()) return null
  const parsed = Date.parse(since)
  if (!Number.isFinite(parsed)) {
    throw new Error(`list_jobs: "since" must be an ISO timestamp, got "${since}".`)
  }
  return parsed
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.trunc(value), min), max)
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
