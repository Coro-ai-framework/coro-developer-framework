// ── Contribution coverage ────────────────────────────────────────────────────
//
// A contribution job is dispatched with N approved findings and is allowed to
// ship fewer. The planner is the first party in the chain to read the actual
// repository, and findings that clustered in a retrospective's metrics can
// turn out to be unrelated edits a maintainer would ask to split —
// `oss-planner.md` deliberately registers only the coupled subset.
//
// What the workflow had no way to express is the remainder. `escalate` is the
// only tool that records "a human must act", and it terminates the job, so
// escalating leftovers throws away the PR the job just earned. Faced with
// that, the planner does the sensible thing and writes its deferral into the
// plan artefact and a log line — where nothing reads it. The job reports
// `complete`, and the dispatching retrospective's ledger goes on claiming the
// child handled every finding it was given.
//
// So the runner derives coverage rather than trusting either party to report
// it. `params.findings` is what was dispatched; the `pr-link` artefacts say
// which of those a pull request actually claims. Anything left over is raised
// as an escalation naming the upstream issues that still need a job. Derived,
// so no agent can forget to mention it; evaluated at completion, so it costs
// the in-scope PR nothing.

import type { Artifact, Job } from '@coro-ai/cloud-protocol'
import { isOssContributionJob } from './oss-contribution'

/** A dispatched finding, read defensively — this survived a trip through `job.params`. */
export interface DispatchedFinding {
  id: string
  title?: string
  issueNumber?: number
  issueUrl?: string
}

export interface ContributionCoverageDecision {
  /** Findings a `pr-link` artefact claims. */
  implemented: DispatchedFinding[]
  /** Findings no PR on this job claims. */
  uncovered: DispatchedFinding[]
  /** PR URLs the job did produce, so the escalation can lead with them. */
  prUrls: string[]
}

/**
 * `null` when the check does not apply: any workflow other than
 * oss-contribution, or a contribution job carrying no findings. Both are
 * absences of a contract rather than breaches of one, and the completion
 * gate above this one takes the same view of a job with no work items.
 */
export function evaluateContributionCoverage(job: Job): ContributionCoverageDecision | null {
  if (!isOssContributionJob(job)) return null

  const findings = readDispatchedFindings(job)
  if (findings.length === 0) return null

  const links = (job.artifacts ?? []).filter(a => a.kind === 'pr-link')
  const claimedIds = new Set<string>()
  const claimedIssues = new Set<number>()
  const prUrls: string[] = []

  for (const link of links) {
    const url = readString(link.data?.url)
    if (url) prUrls.push(url)
    for (const id of readFindingIds(link)) claimedIds.add(id)
    // Fallback for a single-finding PR whose artefact omits `findingIds`:
    // the issue it points at identifies the finding just as well. The
    // artefact's `retrospectiveFindingId` is deliberately *not* consulted —
    // the contributor copies it straight from `params`, so it echoes the
    // first dispatched finding whether or not the PR implements it.
    const issue = readIssueNumber(link)
    if (issue !== undefined) claimedIssues.add(issue)
  }

  const implemented: DispatchedFinding[] = []
  const uncovered: DispatchedFinding[] = []
  for (const finding of findings) {
    const claimed =
      claimedIds.has(finding.id)
      || (finding.issueNumber !== undefined && claimedIssues.has(finding.issueNumber))
    ;(claimed ? implemented : uncovered).push(finding)
  }

  return { implemented, uncovered, prUrls }
}

/**
 * The escalation body. It leads with what shipped, because a job that opened
 * a good PR should not read as a failure, and it says plainly that the
 * planner may have been right — the defect being reported is the missing
 * hand-off, not the scope decision.
 */
export function buildContributionCoverageMessage(
  decision: ContributionCoverageDecision,
): string {
  const total = decision.implemented.length + decision.uncovered.length
  const lines: string[] = [
    `Contribution incomplete: ${decision.implemented.length} of ${total} dispatched ` +
      `findings reached a pull request.`,
    '',
  ]

  if (decision.prUrls.length > 0) {
    lines.push(`Opened: ${decision.prUrls.join(', ')}`)
    lines.push('')
  }

  lines.push('No PR on this job claims:')
  for (const finding of decision.uncovered) {
    const issue = finding.issueNumber !== undefined ? ` (#${finding.issueNumber})` : ''
    const title = finding.title ? ` — ${finding.title}` : ''
    lines.push(`  - ${finding.id}${issue}${title}`)
  }
  lines.push('')
  lines.push(
    'Leaving these out may well have been correct: unrelated findings do not ' +
      'belong in one reviewable PR. But their upstream issues are open and no ' +
      'job owns them. Read this job\'s implementation plan for the reason, then ' +
      'dispatch a contribution job for the remaining issues or close them ' +
      'upstream. Nothing else will pick them up.',
  )

  return lines.join('\n')
}

/** Upstream issues still needing a job, for the log line and re-dispatch. */
export function uncoveredIssueNumbers(decision: ContributionCoverageDecision): number[] {
  return decision.uncovered
    .map(f => f.issueNumber)
    .filter((n): n is number => n !== undefined)
}

function readDispatchedFindings(job: Job): DispatchedFinding[] {
  const raw = (job.params as Record<string, unknown> | undefined)?.findings
  if (!Array.isArray(raw)) return []
  const findings: DispatchedFinding[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const id = readString(row.id)
    if (!id) continue
    findings.push({
      id,
      title: readString(row.title),
      issueNumber: readNumber(row.issueNumber),
      issueUrl: readString(row.issueUrl),
    })
  }
  return findings
}

/**
 * `findingIds` should be an array, but the field is written by an agent from
 * a markdown template, so a comma-separated string is just as likely. An
 * unsubstituted `<placeholder>` is discarded rather than treated as an id.
 */
function readFindingIds(link: Artifact): string[] {
  const raw = link.data?.findingIds
  const tokens = Array.isArray(raw)
    ? raw.map(v => readString(v))
    : readString(raw)?.split(/[,\s]+/) ?? []
  return tokens
    .map(token => token?.trim())
    .filter((token): token is string => Boolean(token) && !/[<>]/.test(token!))
}

function readIssueNumber(link: Artifact): number | undefined {
  const direct = readNumber(link.data?.issueNumber)
  if (direct !== undefined) return direct
  const url = readString(link.data?.issueUrl)
  const match = url?.match(/(\d+)\s*$/)
  return match ? Number(match[1]) : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}
