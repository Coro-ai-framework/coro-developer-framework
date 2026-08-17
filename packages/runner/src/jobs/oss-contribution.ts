// ── Open-source contribution jobs ────────────────────────────────────────────
//
// A retrospective finding categorised `base-intelligence` or `runner-code`
// is a defect in Coro that every install shares. The retrospective does
// not write the fix: its context is aggregated metrics, it has no build
// or test loop, and whole-file dumps from that context produced bad PRs.
// It files the issue, then dispatches an implementation job — which
// already knows how to plan, code, review, and verify.
//
// What makes this job different from any other implementation job is only
// its geography: it clones a **fork**, and it opens its PR against the
// **upstream** repository it cannot push to. Both facts travel in `params`
// so `workflows/oss-contribution/workflow.md` can read them, and this
// module is the one place that shapes them.
//
// One job may carry several findings. Intelligence and runner code live
// in the same repository, and a runner change plus the agent text that
// describes it is one reviewable story. Unrelated findings still belong
// in separate PRs — the planner decides, and the workflow forbids a
// stack. The briefing is assembled here so every child sees the same
// shape, not whatever prose the analyst happened to write around the
// list.

import {
  OSS_CONTRIBUTION_WORKFLOW_PATH,
  type Job,
  type JobInput,
} from '@coro-ai/cloud-protocol'
import type { PredictedMetric } from './retrospective'

/** Categories this workflow will actually implement. Tenant findings stay on `propose_change`. */
export const OSS_CONTRIBUTION_CATEGORIES = ['base-intelligence', 'runner-code'] as const
export type OssContributionCategory = (typeof OSS_CONTRIBUTION_CATEGORIES)[number]

/** Structured briefing the child planner/coder inherit. */
export interface ImprovementBriefing {
  behaviourNow: string
  behaviourWanted: string
  evidence: string
  targetPaths: string[]
  revisionSha?: string
  verified: boolean
  failingTest?: string
  neighbouringWording?: string
  outOfScope?: string[]
  predictedMetric?: PredictedMetric
}

/** Distilled evidence from the retrospective — never raw transcripts. */
export interface OssContributionEvidencePack {
  antiPatterns?: string[]
  toolFailures?: Array<{ toolName: string; errorClass: string; count: number }>
  grepHits?: string[]
}

/** Finding identity plus the briefing the child inherits. */
export interface OssContributionFinding {
  id: string
  category: OssContributionCategory
  issueNumber: number
  issueUrl: string
  /** One line, problem-first. Becomes a work-item title. */
  title: string
  /** What to change and why — already sanitised, since it reaches a public PR. */
  description: string
  briefing?: ImprovementBriefing
  evidencePack?: OssContributionEvidencePack
}

export interface OssContributionRequest {
  /** `owner/repo` of the upstream repository the PR targets. */
  upstreamSlug: string
  /** `owner/repo` of the fork the job clones and pushes to. */
  forkSlug: string
  /** Account owning the fork — the `sourceOwner` of the eventual PR. */
  forkOwner: string
  /** Default branch of the upstream repo; the PR's base. */
  baseBranch: string
  /** Retrospective that dispatched this. */
  retrospectiveJobId: string
  /** Approved findings this job is asked to implement. At least one. */
  findings: OssContributionFinding[]
}

/**
 * Build the child job. Three params are load-bearing:
 *
 * - `repo` / `repoSlug` is the **fork**, because that is what the job can
 *   clone and push to. The GitHub plugin honours the owner in the slug, so
 *   a fork under a different account than the configured org still clones.
 * - `upstreamRepo` + `prSourceOwner` are what the workflow passes to
 *   `scm_create_pr` to make the PR cross-repository. Without them the job
 *   would open a PR from the fork into the fork, which nobody upstream
 *   ever sees.
 * - `epicAllowed: false`, so a contribution job cannot promote itself into
 *   a campaign and fan out into an unbounded number of upstream PRs.
 *
 * `params.findings` is the source of truth for what to implement.
 * `upstreamIssueNumber` / `retrospectiveFindingId` mirror the first
 * finding so anything still reading the original singular fields does
 * not silently lose the link.
 */
export function buildOssContributionJobInput(request: OssContributionRequest): JobInput {
  const findings = request.findings
  if (findings.length === 0) {
    throw new Error('An oss-contribution job needs at least one finding.')
  }
  const primary = findings[0]!

  return {
    type: 'job',
    workflowPath: OSS_CONTRIBUTION_WORKFLOW_PATH,
    triggerSource: 'internal',
    params: {
      repo: request.forkSlug,
      repoSlug: request.forkSlug,
      serviceName: repoName(request.upstreamSlug),
      description: buildContributionBriefing(findings),
      title: contributionJobTitle(findings),
      scm: 'github',
      upstreamRepo: request.upstreamSlug,
      upstreamIssueNumber: primary.issueNumber,
      upstreamIssueUrl: primary.issueUrl,
      prSourceOwner: request.forkOwner,
      prTargetBranch: request.baseBranch,
      retrospectiveJobId: request.retrospectiveJobId,
      retrospectiveFindingId: primary.id,
      findings,
      epicAllowed: false,
      // The coding checkpoint only parks when this is true. Without it
      // the YAML flag is a no-op and the contribution phase opens the
      // PR with no last look from this install.
      interactive: true,
      // Upstream reviewers are not ours to assign — maintainers pick
      // themselves up. An empty list keeps `scm_create_pr` from defaulting
      // to this install's reviewers, who have no access to the repository.
      reviewers: [],
    },
  }
}

/** Detected from the workflow path, so an overlaid workflow still matches. */
export function isOssContributionJob(job: Pick<Job, 'workflowPath'>): boolean {
  return job.workflowPath === OSS_CONTRIBUTION_WORKFLOW_PATH
}

export function isOssContributionCategory(value: string): value is OssContributionCategory {
  return (OSS_CONTRIBUTION_CATEGORIES as readonly string[]).includes(value)
}

/**
 * Which retrospective destination a finding of this category consumes.
 * Dispatch uses this so an intelligence-only run cannot smuggle a code
 * fix through, and vice versa.
 */
export function contributionTierFor(
  category: OssContributionCategory,
): 'upstreamIntelligence' | 'upstreamCode' {
  return category === 'base-intelligence' ? 'upstreamIntelligence' : 'upstreamCode'
}

/** Dashboard / job-list title: the first finding, with a remainder count. */
export function contributionJobTitle(findings: ReadonlyArray<OssContributionFinding>): string {
  const first = findings[0]
  if (!first) return 'Upstream contribution'
  if (findings.length === 1) return first.title
  return `${first.title} (+${findings.length - 1} more)`
}

export function assembleBriefingDescription(briefing: ImprovementBriefing): string {
  const lines = [
    `Today: ${briefing.behaviourNow.trim()}`,
    `Wanted: ${briefing.behaviourWanted.trim()}`,
    `Evidence: ${briefing.evidence.trim()}`,
    `Files: ${briefing.targetPaths.join(', ')}`,
    `Verified: ${briefing.verified ? 'yes' : 'no — treat file claims as hypotheses'}`,
  ]
  if (briefing.revisionSha) lines.push(`Revision: ${briefing.revisionSha}`)
  if (briefing.failingTest) lines.push(`Failing test: ${briefing.failingTest}`)
  if (briefing.neighbouringWording) lines.push(`Neighbouring wording: ${briefing.neighbouringWording}`)
  if (briefing.outOfScope?.length) lines.push(`Out of scope: ${briefing.outOfScope.join('; ')}`)
  if (briefing.predictedMetric) {
    const baseline = briefing.predictedMetric.baseline !== undefined
      ? `, baseline ${briefing.predictedMetric.baseline}`
      : ''
    lines.push(
      `Predicted metric: ${briefing.predictedMetric.name} should ${briefing.predictedMetric.direction}${baseline}`,
    )
  }
  return lines.join('\n')
}

/**
 * The child job's only briefing. Assembled here so the planner always
 * sees the same sections, and so a multi-finding dispatch cannot forget
 * an item the analyst listed.
 */
export function buildContributionBriefing(findings: ReadonlyArray<OssContributionFinding>): string {
  const header = [
    '# Upstream contribution',
    '',
    'Dispatched by a retrospective after a developer approved the findings.',
    'Implement them as ordinary work items on this fork, then open one pull',
    'request against upstream.',
    '',
    'One reviewable PR. If the findings are one story (they share files, or',
    'one is the instruction side of the other), they belong in that PR.',
    'If they are not, implement the coupled subset — or the first finding',
    'if none couple — and escalate the rest. Do not open a stack of PRs.',
    '',
    'Public writing: never name the dispatching install\'s repositories,',
    'tickets, customers, or people. The briefings below already use aliases.',
    '',
    'Confirm each defect still exists on the fork before writing. If it does',
    'not, drop that finding. For runner-code, the test named in the briefing',
    'must fail on the base SHA and pass on your branch before you hand off.',
    '',
  ]

  const sections = findings.map((finding, index) => {
    const body = finding.briefing
      ? assembleBriefingDescription(finding.briefing)
      : finding.description.trim()
    const pack = finding.evidencePack
      ? [
          '',
          'Evidence pack:',
          ...(finding.evidencePack.antiPatterns?.length
            ? [`- anti-patterns: ${finding.evidencePack.antiPatterns.join(', ')}`]
            : []),
          ...(finding.evidencePack.toolFailures?.length
            ? finding.evidencePack.toolFailures.map(row =>
              `- tool failure: ${row.toolName} ${row.errorClass} ×${row.count}`)
            : []),
          ...(finding.evidencePack.grepHits?.length
            ? finding.evidencePack.grepHits.map(hit => `- grep: ${hit}`)
            : []),
        ]
      : []
    return [
      `## ${index + 1}. ${finding.id} — ${finding.title}`,
      '',
      `Category: ${finding.category}`,
      `Issue: ${finding.issueUrl} (#${finding.issueNumber})`,
      '',
      body,
      ...pack,
      '',
    ].join('\n')
  })

  return `${header.join('\n')}${sections.join('\n')}`.trimEnd() + '\n'
}

function repoName(slug: string): string {
  const parts = slug.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? slug
}
