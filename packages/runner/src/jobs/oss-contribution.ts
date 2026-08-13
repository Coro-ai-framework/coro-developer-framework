// ── Open-source contribution jobs ────────────────────────────────────────────
//
// A retrospective finding categorised `runner-code` cannot be fixed by
// editing markdown: it needs a code change that builds and passes tests.
// The retrospective does not do that work itself — it dispatches an
// ordinary implementation job, which already knows how to plan, code,
// review, and verify.
//
// What makes this job different from any other implementation job is only
// its geography: it clones a **fork**, and it opens its PR against the
// **upstream** repository it cannot push to. Both facts travel in `params`
// so `workflows/oss-contribution/workflow.md` can read them, and this
// module is the one place that shapes them.

import {
  OSS_CONTRIBUTION_WORKFLOW_PATH,
  type Job,
  type JobInput,
} from '@coro-ai/cloud-protocol'

export interface OssContributionRequest {
  /** `owner/repo` of the upstream repository the PR targets. */
  upstreamSlug: string
  /** `owner/repo` of the fork the job clones and pushes to. */
  forkSlug: string
  /** Account owning the fork — the `sourceOwner` of the eventual PR. */
  forkOwner: string
  /** Default branch of the upstream repo; the PR's base. */
  baseBranch: string
  /** Upstream issue this contribution fixes. */
  issueNumber: number
  issueUrl: string
  /** One line, problem-first. Becomes the job's description and PR title. */
  title: string
  /** What to change and why — already sanitised, since it reaches a public PR. */
  description: string
  /** Retrospective that dispatched this. */
  retrospectiveJobId: string
  /** Finding id within that retrospective, for outcome reconciliation. */
  findingId: string
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
 */
export function buildOssContributionJobInput(request: OssContributionRequest): JobInput {
  return {
    type: 'job',
    workflowPath: OSS_CONTRIBUTION_WORKFLOW_PATH,
    triggerSource: 'internal',
    params: {
      repo: request.forkSlug,
      repoSlug: request.forkSlug,
      serviceName: repoName(request.upstreamSlug),
      description: request.description,
      title: request.title,
      scm: 'github',
      upstreamRepo: request.upstreamSlug,
      upstreamIssueNumber: request.issueNumber,
      upstreamIssueUrl: request.issueUrl,
      prSourceOwner: request.forkOwner,
      prTargetBranch: request.baseBranch,
      retrospectiveJobId: request.retrospectiveJobId,
      retrospectiveFindingId: request.findingId,
      epicAllowed: false,
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

function repoName(slug: string): string {
  const parts = slug.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? slug
}
