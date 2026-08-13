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
//   * `phaseUsage` collapses to one row per phase, with each execution
//     attributed to a reason (see `attributePhaseRuns`) so an analyst can
//     tell rework from a workflow doing what it is supposed to do.
//   * Logs are filtered to error-ish lines and capped.
//
// A raw "this phase ran 6 times" count is not a loop signal, and treating
// it as one produced false findings: `coding → review → coding` is the
// required path for every work item, so three work items legitimately
// produce three coding runs, and an interactive checkpoint adds one more
// run per approval because the runner re-enters the departing phase to let
// the agent finish it. Only what is left after subtracting those is rework.
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
  /**
   * Phases that ran more times than the workflow required, with the cost of
   * the excess. Empty for a job that looped a phase per work item and
   * nothing more. This — not a raw run count — is the rework signal.
   */
  reworkPhases: Array<{ phase: string; runs: number; reworkRuns: number; reworkCostUsd: number }>
}

/** Why one execution of a phase happened, derived rather than recorded. */
export type PhaseRunAttribution =
  /** First time this phase saw this work item (or the job's first entry). */
  | 'work-item'
  /** The re-entry the runner performs after a developer approves the phase. */
  | 'checkpoint-resume'
  /** Same work item, no checkpoint to explain it: a loop back. */
  | 'rework'

export interface PhaseRunDetail {
  phase: string
  workItem?: string
  attribution: PhaseRunAttribution
  costUsd: number
  turns: number
}

export interface PhaseRunAggregate {
  phase: string
  /** Number of times this phase executed, for any reason. */
  runs: number
  costUsd: number
  durationMs: number
  turns: number
  models: string[]
  /** Distinct work items this phase handled. `runs` scales with this. */
  workItemsHandled: number
  /** Runs the runner performed to let the agent finish an approved phase. */
  checkpointResumeRuns: number
  /** Runs left unexplained by progression or approval — the real loops. */
  reworkRuns: number
  /** Cost of the `rework` runs alone. Quote this, not `costUsd`. */
  reworkCostUsd: number
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
  const phases = aggregatePhaseRuns(job.phaseUsage ?? [], phaseRunContext(job))
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
    reworkPhases: reworkPhases(phases),
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
 * `phaseUsage` records one snapshot per execution, in order, each stamped
 * with the work item it was attributed to. That is enough to reconstruct
 * why a phase repeated, because only three things cause it:
 *
 * 1. **A new work item.** `coding → review → coding` is the workflow, not a
 *    loop; the first run a phase gives to each work item is expected.
 * 2. **A checkpoint approval.** When a developer approves a phase, the
 *    runner re-enters that phase so the agent can finish its turn — one
 *    extra run per approval, allowed once per work item here.
 * 3. **Rework.** Whatever is left: the same phase, on the same work item,
 *    with nothing structural to explain it.
 *
 * These are *derived*, not recorded. `job.interactive` is live-mutable, so
 * the approval allowance is an estimate; a run classified `rework` is a
 * candidate to investigate, not a proven fault. What matters is that the
 * classification errs toward calling things expected — it undercounts
 * rework rather than manufacturing it, because a false systemic finding
 * costs a maintainer's time and a missed one only waits for next month.
 */
export function attributePhaseRuns(
  phaseUsage: ReadonlyArray<PhaseUsage>,
  context: PhaseRunContext = {},
): PhaseRunDetail[] {
  const scrub = context.scrub ?? ((text: string) => text)
  const checkpointPhases = context.interactive ? context.checkpointPhases : undefined

  const seenWorkItems = new Map<string, Set<string>>()
  const resumeAllowanceUsed = new Map<string, Set<string>>()

  return phaseUsage.map(usage => {
    const key = usage.workItem ?? ''
    const seen = seenWorkItems.get(usage.phase) ?? new Set<string>()
    const resumed = resumeAllowanceUsed.get(usage.phase) ?? new Set<string>()

    let attribution: PhaseRunAttribution
    if (!seen.has(key)) {
      seen.add(key)
      attribution = 'work-item'
    } else if (checkpointPhases?.has(usage.phase) && !resumed.has(key)) {
      resumed.add(key)
      attribution = 'checkpoint-resume'
    } else {
      attribution = 'rework'
    }

    seenWorkItems.set(usage.phase, seen)
    resumeAllowanceUsed.set(usage.phase, resumed)

    return {
      phase: usage.phase,
      ...(usage.workItem ? { workItem: scrub(usage.workItem) } : {}),
      attribution,
      costUsd: round(usage.costUsd ?? 0, 4),
      turns: usage.numTurns ?? 0,
    }
  })
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
      models: [],
      workItemsHandled: 0,
      checkpointResumeRuns: 0,
      reworkRuns: 0,
      reworkCostUsd: 0,
    }
    entry.runs += 1
    entry.costUsd += usage.costUsd ?? 0
    entry.durationMs += usage.durationMs ?? 0
    entry.turns += usage.numTurns ?? 0
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
function phaseRunContext(job: Job, scrub?: (text: string) => string): PhaseRunContext {
  const checkpointPhases = new Set(
    (job.workflowPhases ?? []).filter(phase => phase.interactiveCheckpoint).map(phase => phase.name),
  )
  return {
    checkpointPhases,
    interactive: job.interactive !== false,
    ...(scrub ? { scrub } : {}),
  }
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
