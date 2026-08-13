// ── Upstream contribution tools ──────────────────────────────────────────────
//
// A retrospective finding categorised `base-intelligence` or `runner-code`
// is not this install's problem to keep — it is a defect in Coro that every
// install shares. These tools are how such a finding reaches the upstream
// repository: search for an existing report, add evidence to it or file a
// new issue, then open a pull request from the contributor's fork.
//
// Four properties are load-bearing, and each one exists because the failure
// it prevents is unrecoverable once it has happened:
//
//   1. **Opt-in.** Without `upstream.repoUrl` in the local config every
//      tool here refuses. Publishing is never a default.
//   2. **Tier-gated.** The developer chooses at launch how far findings may
//      travel; a run scoped to `tenant` cannot publish, whatever the
//      analyst decides mid-run.
//   3. **Fail-closed sanitisation.** Titles, bodies, and file contents are
//      checked for tenant identifiers before any request leaves the
//      machine. A leak cannot be deleted from a public repository.
//   4. **Capped per run.** The failure mode is not one wrong issue, it is
//      fifty. Counters live in `job.params` so they survive a phase retry.
//
// Deduplication uses a fingerprint marker embedded in the issue body
// (`<!-- coro-retro:<hash> -->`). The hash is computed here from the
// finding's category, target paths, and normalised title — never accepted
// from the model, so two installs that independently notice the same
// problem converge on the same issue.

import { createHash } from 'node:crypto'
import * as path from 'node:path'

import { GitHubClient, type IssueSearchHit, type RepoInfo } from '../clients/github'
import { defaultWriterCacheRoot } from '../config/local-config'
import type { UpstreamSettings } from '../config/settings'
import { commitAndPush, parseRepoUrl, prepareUpstreamWriter } from '../intelligence/writer'
import { buildOssContributionJobInput } from '../jobs/oss-contribution'
import { retrospectiveTiers, type RetrospectiveTiers } from '../jobs/retrospective'
import { assertRetrospectiveJob } from './retrospective'
import { buildSanitizer } from './sanitize'
import { materialiseUpstreamSource, type UpstreamSourceSnapshot } from './upstream-source'
import type { ToolContext } from './types'

/** Marker written into issue bodies so a later run can find its own report. */
export const UPSTREAM_MARKER_PREFIX = 'coro-retro:'
export const UPSTREAM_ISSUE_LABEL = 'coro-retrospective'
export const UPSTREAM_BRANCH_PREFIX = 'coro/retro/'

/** Only the base intelligence layer is contributable through this path. */
export const UPSTREAM_INTELLIGENCE_PREFIX = 'packages/intelligence-base/layer/'

/** Counter params backing `upstream.maxIssuesPerRun` / `maxCodeJobsPerRun`. */
const ISSUES_OPENED_PARAM = 'upstreamIssuesOpened'
const CODE_JOBS_PARAM = 'upstreamCodeJobsDispatched'

// ── Fingerprints ─────────────────────────────────────────────────────────────

export interface FindingIdentity {
  category: string
  title: string
  targetPaths?: string[]
}

/**
 * Stable identity for a finding, used to recognise the same problem across
 * runs and across installs.
 *
 * Computed rather than accepted as input: the whole point is that two
 * installs independently noticing "the coder loops on Go test scaffolding"
 * produce the same hash and land on the same issue, which only holds if
 * the normalisation is done in one place.
 */
export function fingerprintFinding(finding: FindingIdentity): string {
  const paths = [...(finding.targetPaths ?? [])].map(p => p.trim()).filter(Boolean).sort()
  const material = [finding.category.trim(), paths.join(','), normalizeTitle(finding.title)].join('|')
  return createHash('sha256').update(material).digest('hex').slice(0, 16)
}

/** Lowercase, punctuation-free, whitespace-collapsed — so wording drift still matches. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function upstreamMarker(fingerprint: string): string {
  return `<!-- ${UPSTREAM_MARKER_PREFIX}${fingerprint} -->`
}

/**
 * A finding with no category or title cannot be fingerprinted, and a
 * fingerprint computed from partial input would silently defeat
 * deduplication — so this refuses rather than filling in blanks.
 */
function requireFinding(finding: FindingIdentity | undefined, toolName: string): FindingIdentity {
  if (!finding?.category?.trim() || !finding.title?.trim()) {
    throw new Error(
      `${toolName} requires \`finding\` with both a category and a title — pass the same ` +
      'values you recorded in the findings artefact so the fingerprint matches across runs.',
    )
  }
  return finding
}

// ── Runtime resolution ───────────────────────────────────────────────────────

interface UpstreamRuntime {
  client: GitHubClient
  config: UpstreamSettings
  /** `owner/repo` of the upstream repository. */
  upstreamSlug: string
  /** Account the runner pushes branches to. */
  forkOwner: string
}

/**
 * Everything an upstream tool needs, or a message explaining exactly which
 * piece of configuration is missing. Errors are written for the agent: it
 * cannot fix a config file, so each one says "record this finding as
 * not-shipped" rather than implying a retry will help.
 */
async function resolveUpstreamRuntime(
  ctx: ToolContext,
  toolName: string,
  tier: keyof RetrospectiveTiers | ReadonlyArray<keyof RetrospectiveTiers> = 'upstreamIntelligence',
): Promise<UpstreamRuntime> {
  assertRetrospectiveJob(ctx, toolName)

  // Several tiers means "any of these" — used by tools that support both
  // contribution paths rather than belonging to one of them.
  const wanted: ReadonlyArray<keyof RetrospectiveTiers> = typeof tier === 'string' ? [tier] : tier
  const tiers = retrospectiveTiers(ctx.job)
  if (!wanted.some(name => tiers[name])) {
    const named = wanted.map(name => `"${name}"`).join(' or ')
    throw new Error(
      `${toolName} is not permitted for this run: the developer launched it with the ${named} ` +
      'destination disabled. Record the finding as not-shipped with reason ' +
      `"${wanted[0]} destination not enabled for this run".`,
    )
  }

  const config = ctx.settings.upstream
  if (!config?.repoUrl) {
    throw new Error(
      `${toolName} needs an upstream destination, but this install has none configured. ` +
      'Ask the operator to set `upstream.repoUrl` in ~/.coro/config.json. Until then, record ' +
      'the finding as not-shipped with reason "no upstream destination configured".',
    )
  }

  const parsed = parseRepoUrl(config.repoUrl)
  if (!parsed) {
    throw new Error(`${toolName}: upstream.repoUrl "${config.repoUrl}" is not a parseable repository URL.`)
  }

  const token = config.token || ctx.settings.github.token
  if (!token) {
    throw new Error(
      `${toolName} needs a GitHub token to reach ${parsed.owner}/${parsed.repoSlug}. Set ` +
      '`upstream.token`, or configure the GitHub plugin. Record the finding as not-shipped ' +
      'with reason "no upstream credentials configured".',
    )
  }

  const forkOwner = config.forkOwner || ctx.settings.github.owner
  if (!forkOwner) {
    throw new Error(
      `${toolName} needs to know which account to push branches to. Set \`upstream.forkOwner\` ` +
      'to your GitHub username. Record the finding as not-shipped with reason ' +
      '"no upstream fork owner configured".',
    )
  }

  return {
    client: new GitHubClient(forkOwner, token, ctx.settings.github.baseUrl),
    config,
    upstreamSlug: `${parsed.owner}/${parsed.repoSlug}`,
    forkOwner,
  }
}

// ── Publication gate ─────────────────────────────────────────────────────────

/**
 * Refuse to publish text that still names this install. Runs against the
 * union of every identifier the runner knows about — not just the current
 * job's — because an escalation quoted from a sibling run carries that
 * run's repository name.
 */
async function assertPublishable(
  ctx: ToolContext,
  toolName: string,
  sections: ReadonlyArray<{ label: string; text: string }>,
): Promise<void> {
  const sanitizer = buildSanitizer(
    await ctx.stateBackend.listJobs(),
    ctx.settings,
    ctx.tenantContext.tenantId,
  )

  const leaks = sections.flatMap(section =>
    sanitizer.findLeaks(section.text).map(leak => ({ ...leak, label: section.label })),
  )
  if (leaks.length === 0) return

  const described = leaks
    .map(leak => `${leak.label}: ${leak.kind} "${leak.value}"`)
    .join('; ')
  throw new Error(
    `${toolName} refused to publish — the text still contains identifiers specific to this ` +
    `install (${described}). Rewrite it using the aliases from the sanitised job reports ` +
    '(repo-A, ticket-ref-1, …) and describe the problem generically. Nothing was sent.',
  )
}

// ── Per-run caps ─────────────────────────────────────────────────────────────

/**
 * Increment a counter on the job and fail once it would exceed `max`.
 *
 * Reads through the state backend rather than trusting the in-memory job,
 * so a phase that ran twice cannot reset its own budget. The charge lands
 * before the API call, not after: a run that fails halfway through
 * publishing should end up under budget rather than retry-looping against
 * a public repository.
 */
async function consumeBudget(
  ctx: ToolContext,
  param: string,
  max: number,
  toolName: string,
  what: string,
): Promise<number> {
  const job = (await ctx.stateBackend.getJob(ctx.job.id)) ?? ctx.job
  const used = typeof job.params?.[param] === 'number' ? (job.params[param] as number) : 0

  if (used >= max) {
    throw new Error(
      `${toolName} refused: this run has already ${what} ${used} time(s), which is the ` +
      `configured limit (${max}). Record the remaining findings as not-shipped with reason ` +
      '"per-run upstream limit reached" and let the next retrospective pick them up.',
    )
  }

  const next = used + 1
  ctx.job = await ctx.stateBackend.updateJob(ctx.job.id, {
    params: { ...job.params, [param]: next },
  })
  return next
}

// ── upstream_checkout ────────────────────────────────────────────────────────

/** Either contribution path is a reason to want the code in front of you. */
const CONTRIBUTION_TIERS: ReadonlyArray<keyof RetrospectiveTiers> = [
  'upstreamIntelligence',
  'upstreamCode',
]

export interface UpstreamCheckoutResult extends UpstreamSourceSnapshot {
  /** Web URL of the snapshotted revision, for citing it in an issue. */
  commitUrl: string
}

/**
 * Put a read-only snapshot of the upstream repository in the job's working
 * directory so a finding can be checked against the code before it is filed.
 *
 * This exists because the analyst's evidence and its remedy come from
 * different places: the evidence is job metrics, which it has, and the
 * remedy names files and behaviour, which until now it could only infer. An
 * inferred remedy that is wrong does not merely waste a maintainer's time —
 * it makes the next report from any install easier to dismiss.
 *
 * Gated on a contribution tier because a run that cannot publish has nothing
 * to verify for publication, and cloning a repository it will not use is
 * pure cost.
 */
export async function upstreamCheckout(
  _args: unknown,
  ctx: ToolContext,
): Promise<UpstreamCheckoutResult> {
  const runtime = await resolveUpstreamRuntime(ctx, 'upstream_checkout', CONTRIBUTION_TIERS)

  const upstreamRepo = await runtime.client.getRepo(runtime.upstreamSlug)
  const snapshot = await materialiseUpstreamSource({
    cloneUrl: upstreamRepo.clone_url,
    repo: upstreamRepo.full_name,
    ref: upstreamRepo.default_branch,
    jobWorkingDir: path.join(ctx.settings.paths.workingDir, ctx.job.id),
    logger: ctx.logger,
  })

  if (snapshot.cloned) {
    await ctx.stateBackend.appendLog(
      ctx.job.id,
      `[upstream] Snapshotted ${snapshot.repo}@${snapshot.ref} (${snapshot.commit.slice(0, 8)}) ` +
      `into ${snapshot.dir}/ for finding verification`,
    )
  }

  return { ...snapshot, commitUrl: `${upstreamRepo.html_url}/tree/${snapshot.commit}` }
}

// ── upstream_search ──────────────────────────────────────────────────────────

export interface UpstreamSearchArgs {
  /** Finding identity — searched by marker, which is exact. */
  finding?: FindingIdentity
  /** Free-text GitHub search, scoped to the upstream repo by the tool. */
  query?: string
  state?: 'open' | 'closed' | 'all'
  limit?: number
}

export interface UpstreamSearchResult {
  repo: string
  fingerprint?: string
  /** True when a hit carries this finding's marker: do not file a new issue. */
  duplicate: boolean
  hits: IssueSearchHit[]
}

/**
 * Look for an existing report before writing a new one. Always call this
 * first: several installs run retrospectives against the same Coro
 * version, and the second one to notice a problem should add evidence to
 * the open issue rather than open a near-duplicate.
 */
export async function upstreamSearch(
  args: UpstreamSearchArgs,
  ctx: ToolContext,
): Promise<UpstreamSearchResult> {
  const runtime = await resolveUpstreamRuntime(ctx, 'upstream_search')

  if (!args.finding && !args.query?.trim()) {
    throw new Error('upstream_search needs either a `finding` or a `query`.')
  }

  const fingerprint = args.finding
    ? fingerprintFinding(requireFinding(args.finding, 'upstream_search'))
    : undefined
  // The marker is a quoted literal so GitHub matches it exactly rather
  // than tokenising the hash.
  const query = fingerprint
    ? `"${UPSTREAM_MARKER_PREFIX}${fingerprint}"`
    : (args.query as string).trim()

  const hits = await runtime.client.searchIssues(runtime.upstreamSlug, query, {
    state: args.state ?? 'open',
    ...(args.limit ? { maxResults: args.limit } : {}),
  })

  return {
    repo: runtime.upstreamSlug,
    ...(fingerprint ? { fingerprint } : {}),
    duplicate: fingerprint
      ? hits.some(hit => hit.body.includes(`${UPSTREAM_MARKER_PREFIX}${fingerprint}`))
      : false,
    hits,
  }
}

// ── upstream_create_issue ────────────────────────────────────────────────────

export interface UpstreamCreateIssueArgs {
  title: string
  body: string
  finding: FindingIdentity
}

export interface UpstreamIssueResult {
  number: number
  url: string
  fingerprint: string
  issuesOpenedThisRun: number
}

/**
 * File a new issue describing a finding. The fingerprint marker is
 * appended to the body so future runs — here or on another install —
 * recognise the report instead of duplicating it.
 */
export async function upstreamCreateIssue(
  args: UpstreamCreateIssueArgs,
  ctx: ToolContext,
): Promise<UpstreamIssueResult> {
  const runtime = await resolveUpstreamRuntime(ctx, 'upstream_create_issue')

  const title = args.title?.trim()
  const body = args.body?.trim()
  if (!title) throw new Error('upstream_create_issue requires a title.')
  if (!body) throw new Error('upstream_create_issue requires a body describing the evidence.')

  await assertPublishable(ctx, 'upstream_create_issue', [
    { label: 'title', text: title },
    { label: 'body', text: body },
  ])

  const fingerprint = fingerprintFinding(requireFinding(args.finding, 'upstream_create_issue'))
  const opened = await consumeBudget(
    ctx,
    ISSUES_OPENED_PARAM,
    runtime.config.maxIssuesPerRun,
    'upstream_create_issue',
    'opened an upstream issue',
  )

  const issue = await runtime.client.createIssue(runtime.upstreamSlug, {
    title,
    body: `${body}\n\n${upstreamMarker(fingerprint)}\n`,
    labels: [UPSTREAM_ISSUE_LABEL],
  })

  await ctx.stateBackend.appendLog(
    ctx.job.id,
    `[upstream] Opened issue #${issue.number} on ${runtime.upstreamSlug} — ${issue.url}`,
  )

  return { number: issue.number, url: issue.url, fingerprint, issuesOpenedThisRun: opened }
}

// ── upstream_comment_issue ───────────────────────────────────────────────────

export interface UpstreamCommentIssueArgs {
  number: number
  body: string
}

/**
 * Add this install's evidence to an existing report. This is the
 * convergence path: an issue with five installs' worth of evidence is far
 * more actionable than five issues with one each.
 */
export async function upstreamCommentIssue(
  args: UpstreamCommentIssueArgs,
  ctx: ToolContext,
): Promise<{ issueNumber: number; url: string }> {
  const runtime = await resolveUpstreamRuntime(ctx, 'upstream_comment_issue')

  if (!Number.isInteger(args.number) || args.number <= 0) {
    throw new Error('upstream_comment_issue requires the issue `number` to comment on.')
  }
  const body = args.body?.trim()
  if (!body) throw new Error('upstream_comment_issue requires a body.')

  await assertPublishable(ctx, 'upstream_comment_issue', [{ label: 'body', text: body }])

  // Comments are posted through the issues API, which is the same endpoint
  // the PR-review path already uses.
  await runtime.client.postComment(runtime.upstreamSlug, args.number, body)
  const issue = await runtime.client.getIssue(runtime.upstreamSlug, args.number)

  await ctx.stateBackend.appendLog(
    ctx.job.id,
    `[upstream] Added evidence to issue #${args.number} on ${runtime.upstreamSlug}`,
  )

  return { issueNumber: args.number, url: issue.url }
}

// ── Fork preparation ─────────────────────────────────────────────────────────

/**
 * Make sure the contributor's fork exists and is level with upstream, and
 * report the upstream default branch every caller needs as its PR base.
 *
 * Syncing matters more than it looks: a fork made months ago branches off
 * stale code, so both the markdown PR and the code job would be written
 * against a tree the maintainers have moved past. A fork that has diverged
 * cannot be fast-forwarded — that is reported, not fatal, because the PR
 * still diffs correctly and a conflict is a reviewer's problem, not a
 * reason to abandon the finding.
 */
async function prepareFork(
  runtime: UpstreamRuntime,
  ctx: ToolContext,
): Promise<{ fork: RepoInfo; upstreamRepo: RepoInfo; forkInSync: boolean }> {
  const fork = await runtime.client.ensureFork(runtime.upstreamSlug, runtime.forkOwner)
  const upstreamRepo = await runtime.client.getRepo(runtime.upstreamSlug)
  const forkInSync = await runtime.client.syncFork(fork.full_name, upstreamRepo.default_branch)
  if (!forkInSync) {
    ctx.logger.warn(
      { fork: fork.full_name, branch: upstreamRepo.default_branch },
      'Fork could not be fast-forwarded to upstream; work will be based on the fork as-is',
    )
  }
  return { fork, upstreamRepo, forkInSync }
}

// ── upstream_open_intelligence_pr ────────────────────────────────────────────

export interface UpstreamPrFile {
  path: string
  content: string
}

export interface UpstreamOpenPrArgs {
  /** Issue this PR fixes. Linking is required — a fix without a report is unreviewable. */
  issueNumber: number
  title: string
  body: string
  branchSlug: string
  files: UpstreamPrFile[]
}

export interface UpstreamPrResult {
  prUrl: string
  prNumber: number
  branch: string
  forkSlug: string
  filesShipped: string[]
  /** False when the fork could not be fast-forwarded to the upstream default branch. */
  forkInSync: boolean
}

/**
 * Open a markdown-only pull request against the upstream repository, from
 * the contributor's fork.
 *
 * Restricted to `packages/intelligence-base/layer/**.md` on purpose. A
 * finding that needs a code change goes through an implementation run,
 * which builds and tests what it writes; this path exists for prose, where
 * the diff is the whole story and a human reviewer can judge it directly.
 */
export async function upstreamOpenIntelligencePr(
  args: UpstreamOpenPrArgs,
  ctx: ToolContext,
): Promise<UpstreamPrResult> {
  const runtime = await resolveUpstreamRuntime(ctx, 'upstream_open_intelligence_pr')

  const title = args.title?.trim()
  const body = args.body?.trim()
  if (!title) throw new Error('upstream_open_intelligence_pr requires a title.')
  if (!body) throw new Error('upstream_open_intelligence_pr requires a body.')
  if (!Number.isInteger(args.issueNumber) || args.issueNumber <= 0) {
    throw new Error(
      'upstream_open_intelligence_pr requires the `issueNumber` this PR fixes. Open or find the ' +
      'issue first with upstream_search / upstream_create_issue.',
    )
  }

  const files = normalizeUpstreamFiles(args.files)

  await assertPublishable(ctx, 'upstream_open_intelligence_pr', [
    { label: 'title', text: title },
    { label: 'body', text: body },
    ...files.map(file => ({ label: file.path, text: file.content })),
  ])

  const { fork, upstreamRepo, forkInSync } = await prepareFork(runtime, ctx)

  const writer = await prepareUpstreamWriter({
    url: fork.clone_url,
    ref: upstreamRepo.default_branch,
    writerCacheRoot: defaultWriterCacheRoot(),
    logger: ctx.logger,
  })

  const branch = `${UPSTREAM_BRANCH_PREFIX}${ctx.job.id}-${toSlug(args.branchSlug || title)}`.slice(0, 200)

  await commitAndPush({
    dir: writer.dir,
    branch,
    baseRef: writer.baseRef,
    files,
    commitMessage: `docs(intelligence): ${title}\n\nFixes #${args.issueNumber}\n`,
    logger: ctx.logger,
  })

  const pr = await runtime.client.createPr({
    repoSlug: runtime.upstreamSlug,
    title,
    description: buildPrBody(body, args.issueNumber, files),
    sourceBranch: branch,
    sourceOwner: runtime.forkOwner,
    targetBranch: upstreamRepo.default_branch,
  })

  await ctx.stateBackend.appendLog(
    ctx.job.id,
    `[upstream] Opened PR #${pr.id} on ${runtime.upstreamSlug} from ${runtime.forkOwner}:${branch} — ${pr.links.html.href}`,
  )

  return {
    prUrl: pr.links.html.href,
    prNumber: pr.id,
    branch,
    forkSlug: fork.full_name,
    filesShipped: files.map(file => file.path),
    forkInSync,
  }
}

/** Validate the payload before anything touches git or the network. */
export function normalizeUpstreamFiles(files: ReadonlyArray<UpstreamPrFile> | undefined): UpstreamPrFile[] {
  if (!files || files.length === 0) {
    throw new Error('upstream_open_intelligence_pr requires at least one file.')
  }

  return files.map(file => {
    const filePath = file.path?.replace(/^\.\//, '').trim() ?? ''
    if (!filePath.startsWith(UPSTREAM_INTELLIGENCE_PREFIX)) {
      throw new Error(
        `Upstream path "${file.path}" is not contributable. This tool ships base-intelligence ` +
        `markdown only, so every path must start with "${UPSTREAM_INTELLIGENCE_PREFIX}". ` +
        'Code changes go through an implementation run instead.',
      )
    }
    if (!filePath.toLowerCase().endsWith('.md')) {
      throw new Error(`Upstream path "${file.path}" must end with .md.`)
    }
    if (!file.content?.trim()) {
      throw new Error(`Upstream file "${file.path}" has empty content.`)
    }
    return { path: filePath, content: file.content }
  })
}

function buildPrBody(body: string, issueNumber: number, files: ReadonlyArray<UpstreamPrFile>): string {
  const lines = [
    body,
    '',
    `Fixes #${issueNumber}`,
    '',
    `**Files (${files.length}):**`,
    ...files.map(file => `- \`${file.path}\``),
    '',
    '---',
    '_Filed by a Coro retrospective after a developer reviewed the finding. ' +
    'Evidence is in the linked issue; identifiers are aliased._',
  ]
  return lines.join('\n')
}

// ── dispatch_improvement_job ─────────────────────────────────────────────────

export interface DispatchImprovementJobArgs {
  /** Upstream issue the contribution fixes. */
  issueNumber: number
  /** One line, problem-first. Becomes the child job's title and its PR title. */
  title: string
  /** What to change and why. Reaches a public PR, so it is leak-checked. */
  description: string
  /** Finding this fixes, for reconciling outcomes later. */
  findingId: string
}

export interface DispatchImprovementJobResult {
  childJobId: string
  forkSlug: string
  upstreamRepo: string
  baseBranch: string
  issueUrl: string
  codeJobsDispatchedThisRun: number
  forkInSync: boolean
}

/**
 * Hand a `runner-code` finding to an implementation job.
 *
 * The retrospective deliberately does not write code. Its context is a
 * pile of aggregated metrics from other jobs, which is the wrong context
 * for editing a codebase, and it has no build or test loop to check
 * itself with. An implementation job has both, so this tool describes the
 * work and lets that job do it — on a fork, with the PR aimed upstream.
 *
 * The child inherits nothing about this install: it is given the upstream
 * issue and a sanitised description, and everything it publishes flows
 * from those.
 */
export async function dispatchImprovementJob(
  args: DispatchImprovementJobArgs,
  ctx: ToolContext,
): Promise<DispatchImprovementJobResult> {
  const runtime = await resolveUpstreamRuntime(ctx, 'dispatch_improvement_job', 'upstreamCode')

  const dispatch = ctx.dispatchJob
  if (!dispatch) {
    throw new Error(
      'dispatch_improvement_job cannot start jobs in this runtime (no dispatcher available). ' +
      'Record the finding as not-shipped with reason "job dispatch unavailable" — the upstream ' +
      'issue you filed is still the useful outcome.',
    )
  }

  const title = args.title?.trim()
  const description = args.description?.trim()
  const findingId = args.findingId?.trim()
  if (!title) throw new Error('dispatch_improvement_job requires a title.')
  if (!description) {
    throw new Error(
      'dispatch_improvement_job requires a description: the child job starts with no knowledge ' +
      'of your analysis, so state the behaviour to change, the files involved, and how to verify it.',
    )
  }
  if (!findingId) {
    throw new Error('dispatch_improvement_job requires the `findingId` this job fixes.')
  }
  if (!Number.isInteger(args.issueNumber) || args.issueNumber <= 0) {
    throw new Error(
      'dispatch_improvement_job requires the `issueNumber` this job fixes. File the issue first ' +
      'with upstream_create_issue — a code PR with no report behind it is unreviewable.',
    )
  }

  await assertPublishable(ctx, 'dispatch_improvement_job', [
    { label: 'title', text: title },
    { label: 'description', text: description },
  ])

  const { fork, upstreamRepo, forkInSync } = await prepareFork(runtime, ctx)
  const issue = await runtime.client.getIssue(runtime.upstreamSlug, args.issueNumber)

  const dispatched = await consumeBudget(
    ctx,
    CODE_JOBS_PARAM,
    runtime.config.maxCodeJobsPerRun,
    'dispatch_improvement_job',
    'dispatched an upstream code job',
  )

  const child = await dispatch(buildOssContributionJobInput({
    upstreamSlug: runtime.upstreamSlug,
    forkSlug: fork.full_name,
    forkOwner: runtime.forkOwner,
    baseBranch: upstreamRepo.default_branch,
    issueNumber: args.issueNumber,
    issueUrl: issue.url,
    title,
    description,
    retrospectiveJobId: ctx.job.id,
    findingId,
  }))

  await ctx.stateBackend.appendLog(
    ctx.job.id,
    `[upstream] Dispatched contribution job ${child.id} for issue #${args.issueNumber} ` +
    `on ${runtime.upstreamSlug} (fork ${fork.full_name})`,
  )

  return {
    childJobId: child.id,
    forkSlug: fork.full_name,
    upstreamRepo: runtime.upstreamSlug,
    baseBranch: upstreamRepo.default_branch,
    issueUrl: issue.url,
    codeJobsDispatchedThisRun: dispatched,
    forkInSync,
  }
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'finding'
}
