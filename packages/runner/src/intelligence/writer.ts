// ── Intelligence writer ──────────────────────────────────────────────────────
//
// The writer ships proposals to the two writable intelligence layers:
//
//   - tenant: a separate full clone of `tenant.overlay.gitRemote.url`
//             (lives at `<writerCacheRoot>/<tenantId>/tenant/`)
//   - repo:   the active job's already-cloned target repo
//             (`<workingRoot>/<jobId>/<repoSlug>`), writing under `.coro/`
//
// The base layer (`@coro/intelligence-base`) is intentionally not writable.
//
// Why a separate clone for tenant?
//   The intelligence resolver's read cache (`loaders/git-remote.ts`) is
//   shallow + `--single-branch` + hard-reset-on-every-job, which makes it
//   unsuitable for hosting feature branches. The writer needs a stable
//   working tree it can branch off and push from across multiple jobs.
//
// Why reuse the job's repo clone for `.coro/` writes?
//   The agent has already cloned the target repo into the job's working
//   dir using configured BB/GH credentials. Re-cloning would duplicate
//   work and risk credential drift. We just create a feature branch in
//   that same checkout.
//
// Authentication
//   We rely on whatever git auth the operator has configured (SSH agent,
//   credential helper, or `user:token@` embedded in the URL) — same as
//   the read-side `git-remote.ts` loader. `core.askpass=` and
//   `GIT_TERMINAL_PROMPT=0` are set so a misconfigured environment fails
//   fast instead of hanging on a hidden prompt.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { Logger } from 'pino'
import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git'

import type { BitBucketClient, CreatePrOptions, PullRequest } from '../clients/bitbucket'
import type { GitHubClient } from '../clients/github'

// ── Types ────────────────────────────────────────────────────────────────────

export type ProposalLayer = 'tenant' | 'repo'

/**
 * Materialised writer working tree. The caller stages files into
 * `dir`, calls {@link commitAndPush}, then {@link openProposalPr}.
 */
export interface WriterClone {
  /** Absolute path to the working tree the writer should commit into. */
  dir: string
  /** Branch the working tree was reset to (e.g. `main`). */
  baseRef: string
  /** Remote URL — used to choose the PR client and parse the repoSlug. */
  remoteUrl: string
}

export interface PrepareTenantWriterArgs {
  url: string
  ref?: string
  tenantId: string
  /** Root under which writer clones live (`~/.coro/cache/writers/`). */
  writerCacheRoot: string
  logger: Logger
  /** Optional injection point for tests. */
  gitFactory?: (cwd: string) => SimpleGit
}

export interface PrepareRepoWriterArgs {
  /** `<workingRoot>/<jobId>/<repoSlug>` — the agent's clone of the target repo. */
  repoCheckoutDir: string
  /** Default branch to use as the proposal's base (defaults to `main`). */
  baseRef?: string
  logger: Logger
  gitFactory?: (cwd: string) => SimpleGit
}

export interface CommitAndPushArgs {
  dir: string
  branch: string
  baseRef: string
  files: ReadonlyArray<{ path: string; content: string }>
  commitMessage: string
  logger: Logger
  gitFactory?: (cwd: string) => SimpleGit
}

export interface OpenProposalPrArgs {
  remoteUrl: string
  branch: string
  baseRef: string
  title: string
  body: string
  reviewerUsernames?: string[]
  bbCoder: BitBucketClient
  ghClient: GitHubClient | null
  logger: Logger
}

export interface OpenedProposalPr {
  /** Provider-specific PR id. */
  id: number
  /** Web URL of the opened PR. */
  url: string
  /** `'github' | 'bitbucket'` for downstream telemetry. */
  provider: 'github' | 'bitbucket'
}

// ── Tenant writer ────────────────────────────────────────────────────────────

const DEFAULT_REF = 'main'

/**
 * Ensure a full working clone of the tenant overlay exists at
 * `<writerCacheRoot>/<tenantId>/tenant/`, on the requested `ref`,
 * with no leftover state from previous runs.
 *
 * Strategy (kept simple on purpose):
 *   - First call:    `git clone <url> <dir>` (full clone — no `--depth`,
 *                    no `--single-branch`)
 *   - Subsequent:    `git fetch origin <ref>` + checkout + reset to
 *                    `origin/<ref>` (any local proposal branches from
 *                    earlier jobs are left alone — they live in
 *                    `coro/proposal/...` namespace and never collide
 *                    with `main` or peers).
 *
 * Returns the working dir, the base ref the dir is anchored at, and
 * the remote URL (verbatim — no credential injection).
 */
export async function prepareTenantWriter(
  args: PrepareTenantWriterArgs,
): Promise<WriterClone> {
  const { url, tenantId, writerCacheRoot, logger } = args
  const ref = args.ref ?? DEFAULT_REF
  const factory = args.gitFactory ?? defaultGitFactory

  if (!url) throw new Error('prepareTenantWriter: url is required')
  if (!tenantId) throw new Error('prepareTenantWriter: tenantId is required')

  const dir = path.join(writerCacheRoot, tenantId, 'tenant')
  const exists = await isGitRepo(dir)

  if (!exists) {
    await fs.rm(dir, { recursive: true, force: true })
    const parent = path.dirname(dir)
    await fs.mkdir(parent, { recursive: true })
    const git = factory(parent)
    // Full clone — we need to be able to branch off any commit and push.
    await git.clone(url, dir)
    logger.info({ tenantId, url, dir }, 'Cloned tenant overlay (writer)')
  }

  // Refresh + checkout target ref.
  const git = factory(dir)
  try {
    await git.fetch('origin', ref)
    // checkoutBranch handles "branch exists locally" via a plain checkout;
    // if it doesn't, we create it tracking origin/<ref>.
    const branches = await git.branchLocal()
    if (branches.all.includes(ref)) {
      await git.checkout(ref)
    } else {
      await git.checkout(['-b', ref, `origin/${ref}`])
    }
    await git.reset(['--hard', `origin/${ref}`])
  } catch (err) {
    logger.error({ err, tenantId, url, ref }, 'Failed to refresh tenant writer clone')
    throw new Error(
      `Failed to refresh tenant writer clone at ${dir} (ref=${ref}): ${(err as Error).message}`,
    )
  }

  return { dir, baseRef: ref, remoteUrl: url }
}

// ── Repo writer ──────────────────────────────────────────────────────────────

/**
 * Materialise a writer clone for the project layer.
 *
 * We re-use the active job's clone of the target repo rather than
 * making a fresh checkout — credentials, refs, and disk usage all
 * stay in one place. The caller is responsible for ensuring the
 * agent has cloned the repo before `propose_change` is invoked
 * (in the normal flow this happens during the coding phase).
 *
 * Returns the working dir, base ref, and the origin URL discovered
 * via `git config --get remote.origin.url` so {@link openProposalPr}
 * can pick the right provider client.
 */
export async function prepareRepoWriter(
  args: PrepareRepoWriterArgs,
): Promise<WriterClone> {
  const { repoCheckoutDir, logger } = args
  const factory = args.gitFactory ?? defaultGitFactory

  if (!repoCheckoutDir) {
    throw new Error('prepareRepoWriter: repoCheckoutDir is required')
  }
  if (!(await isGitRepo(repoCheckoutDir))) {
    throw new Error(
      `prepareRepoWriter: ${repoCheckoutDir} is not a git checkout. ` +
        `The agent must clone the target repo before calling propose_change ` +
        `with targetLayer="repo".`,
    )
  }

  const git = factory(repoCheckoutDir)
  const baseRef = args.baseRef ?? (await detectDefaultBranch(git)) ?? DEFAULT_REF

  let remoteUrl = ''
  try {
    const url = await git.getConfig('remote.origin.url')
    remoteUrl = (url.value ?? '').trim()
  } catch (err) {
    logger.warn(
      { err, repoCheckoutDir },
      'Could not read remote.origin.url; PR opening will fail without it',
    )
  }

  if (!remoteUrl) {
    throw new Error(
      `prepareRepoWriter: ${repoCheckoutDir} has no origin remote. ` +
        `Cannot open a proposal PR without a remote URL.`,
    )
  }

  return { dir: repoCheckoutDir, baseRef, remoteUrl }
}

// ── Commit + push ────────────────────────────────────────────────────────────

/**
 * Create a fresh feature branch off `baseRef`, write each file
 * (creating parent directories as needed), stage everything, commit,
 * and push to origin with `--set-upstream`.
 *
 * Idempotency: if the branch already exists locally (e.g. from a
 * crashed earlier run) we hard-reset it to `origin/<baseRef>` so the
 * commit history is deterministic. This is intentional — proposal
 * branches are short-lived and any uncommitted scraps from a previous
 * crash are not worth recovering.
 */
export async function commitAndPush(args: CommitAndPushArgs): Promise<void> {
  const { dir, branch, baseRef, files, commitMessage, logger } = args
  const factory = args.gitFactory ?? defaultGitFactory

  if (!branch || !branch.startsWith('coro/proposal/')) {
    // Defence in depth — propose_change generates branches in this
    // namespace. If something else passes a stray branch, refuse so
    // we never accidentally write to `main` etc.
    throw new Error(`commitAndPush: refusing to commit onto branch "${branch}" — must be in coro/proposal/* namespace`)
  }

  const git = factory(dir)

  // Make sure we start from a clean baseRef.
  await git.checkout(baseRef)
  await git.reset(['--hard', `origin/${baseRef}`])

  // Create / re-create the feature branch off baseRef.
  const branches = await git.branchLocal()
  if (branches.all.includes(branch)) {
    await git.checkout(branch)
    await git.reset(['--hard', `origin/${baseRef}`])
  } else {
    await git.checkout(['-b', branch])
  }

  // Write files.
  for (const file of files) {
    const abs = path.resolve(dir, file.path)
    const rel = path.relative(dir, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`commitAndPush: file path "${file.path}" escapes the writer dir`)
    }
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, file.content, 'utf-8')
  }

  await git.add('.')

  // Detect "no changes" — happens if the agent proposed content identical
  // to what already lives on baseRef. Treat as a clean no-op.
  const status = await git.status()
  if (status.staged.length === 0 && status.created.length === 0 && status.modified.length === 0 && status.deleted.length === 0) {
    logger.warn({ branch, dir }, 'No changes detected — skipping commit/push')
    throw new Error(
      `Proposal would produce an empty diff against ${baseRef}. ` +
        `Either the proposed content is identical to what is already merged, ` +
        `or the targetLayer was wrong.`,
    )
  }

  await git.commit(commitMessage)
  await git.push('origin', branch, ['--set-upstream'])
  logger.info({ branch, baseRef, dir }, 'Pushed proposal branch')
}

// ── Open PR ──────────────────────────────────────────────────────────────────

/**
 * Open a PR for the just-pushed branch. The provider is chosen by the
 * host of `remoteUrl`:
 *   - github.com → ghClient
 *   - bitbucket.org → bbCoder
 *   - any other host → throws (we don't have a client for it yet)
 *
 * The runner's existing PR clients are scoped to a single
 * workspace/owner, so we also validate that the URL's owner matches
 * the configured client. If it doesn't, the user has misconfigured
 * `git.workspace`/`github.owner` for the target repo and we fail
 * loudly rather than opening a PR in the wrong place.
 */
export async function openProposalPr(
  args: OpenProposalPrArgs,
): Promise<OpenedProposalPr> {
  const { remoteUrl, branch, baseRef, title, body, reviewerUsernames, bbCoder, ghClient, logger } = args

  const parsed = parseRepoUrl(remoteUrl)
  if (!parsed) {
    throw new Error(`openProposalPr: cannot parse repo URL "${remoteUrl}"`)
  }

  const opts: CreatePrOptions = {
    repoSlug: parsed.repoSlug,
    title,
    description: body,
    sourceBranch: branch,
    targetBranch: baseRef,
    ...(reviewerUsernames && reviewerUsernames.length > 0 ? { reviewerUsernames } : {}),
  }

  let pr: PullRequest
  let provider: 'github' | 'bitbucket'

  if (parsed.host.endsWith('github.com')) {
    if (!ghClient) {
      throw new Error(
        `openProposalPr: ${remoteUrl} is a GitHub repo but no GitHub client is configured. ` +
          `Set git.provider="github" with a token in your config.`,
      )
    }
    pr = await ghClient.createPr(opts)
    provider = 'github'
  } else if (parsed.host.endsWith('bitbucket.org')) {
    pr = await bbCoder.createPr(opts)
    provider = 'bitbucket'
  } else {
    throw new Error(
      `openProposalPr: unsupported provider host "${parsed.host}" — only github.com and bitbucket.org are wired today.`,
    )
  }

  logger.info({ prId: pr.id, url: pr.links.html.href, branch, provider }, 'Opened proposal PR')
  return { id: pr.id, url: pr.links.html.href, provider }
}

// ── URL parsing ──────────────────────────────────────────────────────────────

/**
 * Extract `host`, `owner`, and `repoSlug` from a git URL. Supports both
 * SSH (`git@github.com:owner/repo.git`) and HTTPS
 * (`https://github.com/owner/repo.git`, with or without embedded creds)
 * forms. Strips any trailing `.git`.
 *
 * Returns `null` if the URL can't be parsed — the caller surfaces a
 * clean error rather than throwing here.
 */
export function parseRepoUrl(url: string): { host: string; owner: string; repoSlug: string } | null {
  if (!url) return null
  const trimmed = url.trim()

  // SSH form: [user@]host:owner/repo[.git]
  const ssh = /^(?:[^@]+@)?([^:]+):([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed)
  if (ssh && !trimmed.includes('://')) {
    return { host: ssh[1], owner: ssh[2], repoSlug: ssh[3] }
  }

  // HTTPS / SSH-with-protocol form
  try {
    const u = new URL(trimmed)
    const host = u.host
    // pathname like `/owner/repo.git`
    const parts = u.pathname.replace(/^\/+/, '').split('/')
    if (parts.length < 2) return null
    const owner = parts[0]
    const repoSlug = parts.slice(1).join('/').replace(/\.git$/, '')
    if (!owner || !repoSlug) return null
    return { host, owner, repoSlug }
  } catch {
    return null
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

async function isGitRepo(dir: string): Promise<boolean> {
  const stat = await fs.stat(path.join(dir, '.git')).catch(() => null)
  return stat?.isDirectory() ?? false
}

/**
 * Best-effort detection of the default branch by asking origin.
 * Returns `null` if the symbolic ref isn't readable; callers should
 * fall back to `main`.
 */
async function detectDefaultBranch(git: SimpleGit): Promise<string | null> {
  try {
    // `origin/HEAD` resolves to the default branch on origin.
    const result = await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    const trimmed = (result ?? '').trim()
    if (trimmed.startsWith('origin/')) return trimmed.slice('origin/'.length)
  } catch {
    // Fall through to null.
  }
  return null
}

// Force non-interactive git: `GIT_TERMINAL_PROMPT=0` blocks the
// terminal-fallback prompt and `GIT_ASKPASS=` (empty string) disables
// the configured external askpass helper. Together they make a missing
// credential helper / SSH agent fail fast with "Authentication failed"
// rather than hang waiting for input.
//
// simple-git refuses `GIT_ASKPASS` overrides by default (it considers
// any modification of the askpass env an "unsafe operation"). We
// explicitly opt into it via `unsafe.allowUnsafeAskPass` because we
// are *clearing* the value, not redirecting it to a malicious helper.
const GIT_SPAWN_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' }

function defaultGitFactory(cwd: string): SimpleGit {
  const opts: Partial<SimpleGitOptions> = {
    baseDir: cwd,
    unsafe: { allowUnsafeProtocolOverride: false, allowUnsafeAskPass: true } as unknown as SimpleGitOptions['unsafe'],
  }
  return simpleGit(opts).env(GIT_SPAWN_ENV)
}
