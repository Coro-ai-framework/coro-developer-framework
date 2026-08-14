// ── Retrospective dispatch ───────────────────────────────────────────────────
//
// One place that knows how to shape a retrospective run, so the CLI, the
// dashboard, and any future trigger all produce identical jobs. Everything
// here is pure: the caller does the dispatching.
//
// Two properties are load-bearing and easy to get wrong by hand:
//
//   1. `interactive: true`. The runner only honours a phase's
//      `interactive_checkpoint` when `job.interactive` is set, so without
//      this flag the analysis→shipping park silently does not happen and
//      the run ships without review. It is not a caller option.
//   2. Tier flags. The window says how much history to read; the tiers say
//      how far a finding may travel. Both live in `params` where the
//      prompt builder exposes them to the agent.

import {
  JobType,
  RETROSPECTIVE_WORKFLOW_PATH,
  STATUS_AWAITING_DEVELOPER_INPUT,
  type Job,
  type JobInput,
} from '@coro-ai/cloud-protocol'
import { isStoppedStatus } from './helpers'

export const RETROSPECTIVE_DEFAULT_WINDOW = 25
export const RETROSPECTIVE_MIN_WINDOW = 5
export const RETROSPECTIVE_MAX_WINDOW = 100

/**
 * Where the analyst is allowed to send an approved finding. Analysis
 * always runs; these only gate the shipping phase.
 */
export interface RetrospectiveTiers {
  /** Propose to this install's own intelligence layers. */
  tenant: boolean
  /** File upstream issues and dispatch contribution jobs for base-intelligence findings. */
  upstreamIntelligence: boolean
  /** File upstream issues and dispatch contribution jobs for runner-code findings. */
  upstreamCode: boolean
}

export interface RetrospectiveRequest {
  jobWindow?: number
  tiers?: Partial<RetrospectiveTiers>
}

export const RETROSPECTIVE_DEFAULT_TIERS: RetrospectiveTiers = {
  tenant: true,
  upstreamIntelligence: false,
  upstreamCode: false,
}

export function normalizeRetrospectiveTiers(tiers?: Partial<RetrospectiveTiers>): RetrospectiveTiers {
  return {
    tenant: tiers?.tenant ?? RETROSPECTIVE_DEFAULT_TIERS.tenant,
    upstreamIntelligence: tiers?.upstreamIntelligence ?? RETROSPECTIVE_DEFAULT_TIERS.upstreamIntelligence,
    upstreamCode: tiers?.upstreamCode ?? RETROSPECTIVE_DEFAULT_TIERS.upstreamCode,
  }
}

export function normalizeRetrospectiveWindow(jobWindow?: number): number {
  if (typeof jobWindow !== 'number' || !Number.isFinite(jobWindow)) {
    return RETROSPECTIVE_DEFAULT_WINDOW
  }
  return Math.min(Math.max(Math.trunc(jobWindow), RETROSPECTIVE_MIN_WINDOW), RETROSPECTIVE_MAX_WINDOW)
}

export function buildRetrospectiveJobInput(request: RetrospectiveRequest = {}): JobInput {
  const jobWindow = normalizeRetrospectiveWindow(request.jobWindow)
  const tiers = normalizeRetrospectiveTiers(request.tiers)

  return {
    type: 'retrospective',
    workflowPath: RETROSPECTIVE_WORKFLOW_PATH,
    triggerSource: 'internal',
    params: {
      // Label the job id `coro-retrospective-<ts>` rather than the generic
      // `job-retrospective-<ts>` fallback.
      serviceName: 'coro',
      description: `Cross-job retrospective over the last ${jobWindow} jobs.`,
      jobWindow,
      tiers,
      interactive: true,
    },
  }
}

/**
 * Refuse a run whose destinations it cannot honour.
 *
 * Without this the mismatch only surfaces at the end: the analyst spends
 * a full window's worth of tokens, the developer approves findings, and
 * the shipping phase then reports "no upstream destination configured"
 * for every one of them. Failing at dispatch costs nothing and says what
 * to fix.
 */
export function assertRetrospectiveTiersAvailable(
  tiers: RetrospectiveTiers,
  upstreamConfigured: boolean,
): void {
  if (upstreamConfigured) return
  if (!tiers.upstreamIntelligence && !tiers.upstreamCode) return
  throw new Error(
    'This run asks to contribute findings to the Coro repository, but no upstream ' +
    'destination is configured. Set `upstream.repoUrl` in ~/.coro/config.json (see ' +
    'docs/local-setup.md), or launch with the tenant destination only.',
  )
}

/**
 * Tiers this run was launched with. Read by the upstream tools so a run
 * the developer scoped to their own intelligence cannot publish, whatever
 * the analyst decides mid-run.
 */
export function retrospectiveTiers(job: Job): RetrospectiveTiers {
  return normalizeRetrospectiveTiers(job.params?.['tiers'] as Partial<RetrospectiveTiers> | undefined)
}

/**
 * The retrospective currently in flight, if any. Two concurrent runs would
 * analyse the same window and race to propose the same fixes, so callers
 * refuse to start a second one.
 */
export function findActiveRetrospective(jobs: ReadonlyArray<Job>): Job | undefined {
  return jobs.find(job => job.type === JobType.Retrospective && !isStoppedStatus(job.status))
}

// ── Reading what the analyst produced ────────────────────────────────────────
//
// The analyst records its findings in a `retrospective-report` artefact and
// where they landed in a `retrospective-outcome` artefact. Both `data`
// payloads are authored by a model, so everything below is defensive: a
// malformed entry is dropped rather than thrown, because a slightly wrong
// artefact must not take down the retrospective list page.

export const RETROSPECTIVE_REPORT_KIND = 'retrospective-report'
export const RETROSPECTIVE_OUTCOME_KIND = 'retrospective-outcome'

/** Categories map to the layer that owns the fix. */
export type FindingCategory = 'tenant-intelligence' | 'base-intelligence' | 'runner-code'
export type FindingSeverity = 'high' | 'medium' | 'low'

export interface FindingEvidence {
  jobId: string
  detail: string
  metrics?: Record<string, unknown>
}

export interface RetrospectiveFinding {
  id: string
  title: string
  category: FindingCategory
  severity: FindingSeverity
  evidence: FindingEvidence[]
  proposedRemedy?: string
  targetPaths?: string[]
}

export interface RetrospectiveOutcome {
  findingId: string
  /** Where the finding landed. `none` carries a `reason`. */
  destination: string
  prUrl?: string
  issueUrl?: string
  childJobId?: string
  reason?: string
}

export interface RetrospectiveSummary {
  jobId: string
  status: string
  phase: string
  createdAt: string
  updatedAt: string
  jobWindow: number
  tiers: RetrospectiveTiers
  costUsd: number
  /** True while the job is parked on the analysis→shipping approval gate. */
  awaitingApproval: boolean
  findings: RetrospectiveFinding[]
  outcomes: RetrospectiveOutcome[]
}

const FINDING_CATEGORIES: FindingCategory[] = ['tenant-intelligence', 'base-intelligence', 'runner-code']
const FINDING_SEVERITIES: FindingSeverity[] = ['high', 'medium', 'low']

export function summarizeRetrospective(job: Job): RetrospectiveSummary {
  const report = latestArtifactData(job, RETROSPECTIVE_REPORT_KIND)
  const outcome = latestArtifactData(job, RETROSPECTIVE_OUTCOME_KIND)

  return {
    jobId: job.id,
    status: job.status,
    phase: job.phase,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    jobWindow: normalizeRetrospectiveWindow(numberOr(job.params?.['jobWindow'], undefined)),
    tiers: normalizeRetrospectiveTiers(job.params?.['tiers'] as Partial<RetrospectiveTiers> | undefined),
    costUsd: job.tokenUsage?.totalCostUsd ?? 0,
    // A boundary park (`awaitingNextPhase`) on a retrospective is always the
    // findings gate — the workflow declares one checkpoint. Keyed on that
    // rather than on the phase name so an overlay that renames `analysis`
    // still surfaces the approval controls.
    awaitingApproval:
      job.status === STATUS_AWAITING_DEVELOPER_INPUT && Boolean(job.awaitingNextPhase),
    findings: parseFindings(report?.['findings']),
    outcomes: parseOutcomes(outcome?.['outcomes']),
  }
}

/** Findings from a job's report artefact, or `[]` when it has none yet. */
export function retrospectiveFindings(job: Job): RetrospectiveFinding[] {
  return parseFindings(latestArtifactData(job, RETROSPECTIVE_REPORT_KIND)?.['findings'])
}

function latestArtifactData(job: Job, kind: string): Record<string, unknown> | undefined {
  const matches = (job.artifacts ?? []).filter(artifact => artifact.kind === kind)
  // A re-run of the phase appends a second artefact; the newest wins.
  return matches.length > 0 ? matches[matches.length - 1].data : undefined
}

function parseFindings(raw: unknown): RetrospectiveFinding[] {
  if (!Array.isArray(raw)) return []
  const findings: RetrospectiveFinding[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const id = stringOr(entry['id'], '')
    const title = stringOr(entry['title'], '')
    if (!id || !title) continue
    findings.push({
      id,
      title,
      category: oneOf(entry['category'], FINDING_CATEGORIES, 'base-intelligence'),
      severity: oneOf(entry['severity'], FINDING_SEVERITIES, 'medium'),
      evidence: parseEvidence(entry['evidence']),
      ...(stringOr(entry['proposedRemedy'], '') ? { proposedRemedy: stringOr(entry['proposedRemedy'], '') } : {}),
      ...(stringArray(entry['targetPaths']).length ? { targetPaths: stringArray(entry['targetPaths']) } : {}),
    })
  }
  return findings
}

function parseEvidence(raw: unknown): FindingEvidence[] {
  if (!Array.isArray(raw)) return []
  const evidence: FindingEvidence[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const jobId = stringOr(entry['jobId'], '')
    if (!jobId) continue
    evidence.push({
      jobId,
      detail: stringOr(entry['detail'], ''),
      ...(isRecord(entry['metrics']) ? { metrics: entry['metrics'] } : {}),
    })
  }
  return evidence
}

function parseOutcomes(raw: unknown): RetrospectiveOutcome[] {
  if (!Array.isArray(raw)) return []
  const outcomes: RetrospectiveOutcome[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const findingId = stringOr(entry['findingId'], '')
    if (!findingId) continue
    const optional = (key: string): Record<string, string> => {
      const value = stringOr(entry[key], '')
      return value ? { [key]: value } : {}
    }
    outcomes.push({
      findingId,
      destination: stringOr(entry['destination'], 'unknown'),
      ...optional('prUrl'),
      ...optional('issueUrl'),
      ...optional('childJobId'),
      ...optional('reason'),
    })
  }
  return outcomes
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function numberOr(value: unknown, fallback: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback
}
