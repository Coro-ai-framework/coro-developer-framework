// ── Cross-job history access ─────────────────────────────────────────────────
//
// Read-only views over the install's own job records, exposed to the
// retrospective analyst through `list_jobs`, `get_job_report`, and
// `get_job_log_excerpts`. Clustering and trace summaries live in
// `./job-trace` and reuse the report builders here.
//
// Every other agent sees exactly one job — its own. The retrospective needs
// the opposite: enough shape across many jobs to spot systemic problems
// ("the coding phase ran 4+ times in half of last week's runs"), without
// dragging whole transcripts into the context window. So the reports here
// are aggregates, not dumps:
//
//   * `phaseUsage` collapses to one row per phase, with each execution
//     attributed to a reason (see `attributePhaseRuns`) so an analyst can
//     tell rework from a workflow doing what it is supposed to do.
//   * Token and cache totals already stored on each snapshot are passed
//     through — they used to be dropped, which hid cache blow-ups.
//   * Logs are filtered to error-ish lines and capped.
//
// A raw "this phase ran 6 times" count is not a loop signal, and treating
// it as one produced false findings: `coding → review → coding` is the
// required path for every work item, so three work items legitimately
// produce three coding runs, and an interactive checkpoint adds one more
// run per approval because the runner re-enters the departing phase to let
// the agent finish it. Only what is left after subtracting those is rework.
//
// Attribution is recorded on new snapshots and derived for older ones
// (`jobs/phase-observability.ts`). Output is sanitised by default (see
// `./sanitize`). Callers that need the real identifiers for local-only
// reasoning pass `raw: true`; anything leaving the machine is re-validated
// at the publishing boundary.

import {
  JobType,
  type IntelligenceProvenance,
  type Job,
  type PhaseRunAttribution,
  type PhaseUsage,
} from '@coro-ai/cloud-protocol'
import {
  checkpointPhaseSet,
  derivePhaseAttributions,
} from '../jobs/phase-observability'
import { normalizeRetrospectiveWindow } from '../jobs/retrospective'
import { buildSanitizer, type Sanitizer } from './sanitize'
import { assertRetrospectiveJob } from './retrospective'
import type { ToolContext } from './types'

export type { PhaseRunAttribution } from '@coro-ai/cloud-protocol'

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
  inputTokens: number
  cacheReadInputTokens: number
  escalated: boolean
  workItemCount: number
  /** Highest per-work-item loop count — the evaluator's rework signal. */
  maxLoopCount: number
  /** Sum of `reworkCostUsd` across phases. */
  reworkCostUsd: number
  /**
   * Phases that ran more times than the workflow required, with the cost of
   * the excess. Empty for a job that looped a phase per work item and
   * nothing more. This — not a raw run count — is the rework signal.
   */
  reworkPhases: Array<{ phase: string; runs: number; reworkRuns: number; reworkCostUsd: number }>
  /** Most-failed tool on this job, when a ledger exists. */
  topFailedTool?: string
}

export interface PhaseRunDetail {
  phase: string
  workItem?: string
  attribution: PhaseRunAttribution
  /** `recorded` when the snapshot carried `attribution`; otherwise derived. */
  attributionSource: 'recorded' | 'derived'
  costUsd: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  durationMs: number
  parkReason?: string
}

export interface ToolHistogramEntry {
  toolName: string
  calls: number
  failures: number
}

export interface PhaseRunAggregate {
  phase: string
  /** Number of times this phase executed, for any reason. */
  runs: number
  costUsd: number
  durationMs: number
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  models: string[]
  /** Distinct work items this phase handled. `runs` scales with this. */
  workItemsHandled: number
  /** Runs the runner performed to let the agent finish an approved phase. */
  checkpointResumeRuns: number
  /** Runs left unexplained by progression or approval — the real loops. */
  reworkRuns: number
  /** Cost of the `rework` runs alone. Quote this, not `costUsd`. */
  reworkCostUsd: number
  topFailedTools: ToolHistogramEntry[]
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
  reworkPhases: Array<{ phase: string; runs: number; reworkRuns: number; reworkCostUsd: number }>
  /**
   * Every phase execution in order, each attributed. This is where a claim
   * about avoidable cost has to come from: it names which runs were rework
   * and what each one cost.
   */
  phaseRuns: PhaseRunDetail[]
  insights: Array<{ category: string; summary: string; suggestion?: string; status: string }>
  prs: Array<{ workItem: string; openedAt: string; mergedAt?: string; timeToMergeMs?: number }>
  artifacts: Array<{ id: string; phase: string; kind: string; title: string }>
  workflowSwitches: Array<{ from: string; to: string; reason: string }>
  toolHistogram: ToolHistogramEntry[]
  provenance?: IntelligenceProvenance
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

  // Default to the window the run was launched with, so drilling down covers
  // the same jobs `cluster_window` grouped. Defaulting to a fixed 20 against a
  // 25-job window silently hid five jobs from every follow-up read, which is
  // the kind of gap that makes a real pattern look like it cleared a threshold
  // in some jobs and not others.
  const declaredWindow = ctx.job.params?.['jobWindow']
  const windowDefault = typeof declaredWindow === 'number'
    ? normalizeRetrospectiveWindow(declaredWindow)
    : JOB_LIST_DEFAULT_LIMIT
  const limit = clamp(args.limit ?? windowDefault, 1, JOB_LIST_MAX_LIMIT)
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
  const phases = aggregatePhaseRuns(job.phaseUsage ?? [], phaseRunContext(job))
  const histogram = toolHistogram(job.phaseUsage ?? [])
  const topFailed = histogram.find(entry => entry.failures > 0)
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    workflowPath: job.workflowPath,
    repo: sanitizer.repoAlias(jobRepo(job)),
    createdAt: job.createdAt,
    durationMs: elapsedMs(job.createdAt, job.updatedAt),
    costUsd: round(job.tokenUsage?.totalCostUsd ?? 0, 4),
    inputTokens: job.tokenUsage?.inputTokens ?? sumUsageField(job.phaseUsage ?? [], 'inputTokens'),
    cacheReadInputTokens: job.tokenUsage?.cacheReadInputTokens
      ?? sumUsageField(job.phaseUsage ?? [], 'cacheReadInputTokens'),
    escalated: isEscalated(job),
    workItemCount: job.workItems?.length ?? 0,
    maxLoopCount: (job.workItems ?? []).reduce((max, item) => Math.max(max, item.loopCount ?? 0), 0),
    reworkCostUsd: round(phases.reduce((sum, phase) => sum + phase.reworkCostUsd, 0), 4),
    reworkPhases: reworkPhases(phases),
    ...(topFailed ? { topFailedTool: topFailed.toolName } : {}),
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
  const runContext = phaseRunContext(job, scrub)
  const phases = aggregatePhaseRuns(job.phaseUsage ?? [], runContext)
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
    reworkPhases: reworkPhases(phases),
    phaseRuns: attributePhaseRuns(job.phaseUsage ?? [], runContext),
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
    toolHistogram: toolHistogram(job.phaseUsage ?? []),
    ...(job.intelligenceProvenance
      ? { provenance: scrubProvenance(job.intelligenceProvenance, scrub) }
      : {}),
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

/** What the job can tell us about why its phases repeated. */
export interface PhaseRunContext {
  /** Phases the workflow declared as approval checkpoints. */
  checkpointPhases?: ReadonlySet<string>
  /** Whether those checkpoints were actually enforced for this run. */
  interactive?: boolean
  /** Applied to work-item names, which can carry service identifiers. */
  scrub?: (text: string) => string
}

/**
 * Attribute every phase execution to a reason.
 *
 * New snapshots carry `attribution` recorded at append time. Older jobs
 * do not, so this falls back to the same derivation the runner uses when
 * stamping: first (phase, work item) is expected, one checkpoint resume
 * is allowed, the rest is rework. Derivation undercounts rather than
 * inventing loops. A recorded `parkReason` is passed through so a
 * zero-cost park is not mistaken for rework.
 */
export function attributePhaseRuns(
  phaseUsage: ReadonlyArray<PhaseUsage>,
  context: PhaseRunContext = {},
): PhaseRunDetail[] {
  const scrub = context.scrub ?? ((text: string) => text)
  const attributions = derivePhaseAttributions(phaseUsage, context)

  return phaseUsage.map((usage, index) => ({
    phase: usage.phase,
    ...(usage.workItem ? { workItem: scrub(usage.workItem) } : {}),
    attribution: attributions[index] ?? 'work-item',
    attributionSource: usage.attribution ? 'recorded' : 'derived',
    costUsd: round(usage.costUsd ?? 0, 4),
    turns: usage.numTurns ?? 0,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
    durationMs: usage.durationMs ?? 0,
    ...(usage.parkReason ? { parkReason: scrub(usage.parkReason) } : {}),
  }))
}

/** One row per phase, with the attributed runs counted per reason. */
export function aggregatePhaseRuns(
  phaseUsage: ReadonlyArray<PhaseUsage>,
  context: PhaseRunContext = {},
): PhaseRunAggregate[] {
  const attributed = attributePhaseRuns(phaseUsage, context)
  const byPhase = new Map<string, PhaseRunAggregate>()

  phaseUsage.forEach((usage, index) => {
    const detail = attributed[index]
    const entry: PhaseRunAggregate = byPhase.get(usage.phase) ?? {
      phase: usage.phase,
      runs: 0,
      costUsd: 0,
      durationMs: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      models: [],
      workItemsHandled: 0,
      checkpointResumeRuns: 0,
      reworkRuns: 0,
      reworkCostUsd: 0,
      topFailedTools: [],
    }
    entry.runs += 1
    entry.costUsd += usage.costUsd ?? 0
    entry.durationMs += usage.durationMs ?? 0
    entry.turns += usage.numTurns ?? 0
    entry.inputTokens += usage.inputTokens ?? 0
    entry.outputTokens += usage.outputTokens ?? 0
    entry.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0
    entry.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0
    if (usage.model && !entry.models.includes(usage.model)) entry.models.push(usage.model)

    if (detail.attribution === 'work-item') entry.workItemsHandled += 1
    else if (detail.attribution === 'checkpoint-resume') entry.checkpointResumeRuns += 1
    else {
      entry.reworkRuns += 1
      entry.reworkCostUsd += usage.costUsd ?? 0
    }

    byPhase.set(usage.phase, entry)
  })

  return Array.from(byPhase.values()).map(entry => ({
    ...entry,
    costUsd: round(entry.costUsd, 4),
    reworkCostUsd: round(entry.reworkCostUsd, 4),
    topFailedTools: toolHistogram(
      phaseUsage.filter(usage => usage.phase === entry.phase),
    ).filter(row => row.failures > 0).slice(0, 5),
  }))
}

/** The shortlist a threshold should be applied to. */
function reworkPhases(
  phases: ReadonlyArray<PhaseRunAggregate>,
): Array<{ phase: string; runs: number; reworkRuns: number; reworkCostUsd: number }> {
  return phases
    .filter(phase => phase.reworkRuns > 0)
    .map(phase => ({
      phase: phase.phase,
      runs: phase.runs,
      reworkRuns: phase.reworkRuns,
      reworkCostUsd: phase.reworkCostUsd,
    }))
}

/** Checkpoint phases, from the phase list persisted at job creation. */
export function phaseRunContext(job: Job, scrub?: (text: string) => string): PhaseRunContext {
  return {
    checkpointPhases: checkpointPhaseSet(job.workflowPhases),
    interactive: job.interactive !== false,
    ...(scrub ? { scrub } : {}),
  }
}

export function jobRepo(job: Job): string {
  const slug = job.params?.['repoSlug'] ?? job.params?.['repo']
  return typeof slug === 'string' ? slug : ''
}

export function isEscalated(job: Job): boolean {
  return Boolean(job.escalationMessage) || job.status === 'escalated'
}

export function toolHistogram(phaseUsage: ReadonlyArray<PhaseUsage>): ToolHistogramEntry[] {
  const byName = new Map<string, ToolHistogramEntry>()
  for (const usage of phaseUsage) {
    for (const entry of usage.toolLedger ?? []) {
      const row = byName.get(entry.toolName) ?? { toolName: entry.toolName, calls: 0, failures: 0 }
      row.calls += 1
      if (!entry.success) row.failures += 1
      byName.set(entry.toolName, row)
    }
  }
  return Array.from(byName.values()).sort((a, b) => b.failures - a.failures || b.calls - a.calls)
}

export function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const even = sorted.length % 2 === 0
  const left = sorted[even ? mid - 1 : mid] ?? 0
  const right = sorted[mid] ?? 0
  return even ? (left + right) / 2 : left
}

function sumUsageField(
  phaseUsage: ReadonlyArray<PhaseUsage>,
  field: 'inputTokens' | 'cacheReadInputTokens',
): number {
  return phaseUsage.reduce((sum, usage) => sum + (usage[field] ?? 0), 0)
}

function scrubProvenance(
  provenance: IntelligenceProvenance,
  scrub: (text: string) => string,
): IntelligenceProvenance {
  return {
    ...provenance,
    layers: provenance.layers.map(layer => ({
      ...layer,
      source: scrub(layer.source),
    })),
  }
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

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.trunc(value), min), max)
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
