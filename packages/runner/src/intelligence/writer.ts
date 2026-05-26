// ── Intelligence writer ──────────────────────────────────────────────────────
//
// The writer ships proposals to the two writable intelligence layers:
//
//   - tenant: a separate full clone of `tenant.overlay.gitRemote.url`
//             (lives at `<writerCacheRoot>/<tenantId>/tenant/`)
//   - repo:   the active job's already-cloned target repo
//             (`<workingRoot>/<jobId>/<repoSlug>`), writing under `.coro/`
//
// The base layer (`@coro-ai/intelligence-base`) is intentionally not writable.
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

import type { PluginRegistry } from '../plugins/registry'

import {
  DEFAULT_OVERLAY_REF,
  detectOriginDefaultBranch,
  listOriginRemoteHeads,
  resolveOverlayBaseRef,
} from './git-ref-resolve'

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
  /**
   * Plugin registry used to resolve the SCM plugin from `remoteUrl`.
   * The writer no longer carries hard-wired BitBucket / GitHub
   * clients — every PR-opening path goes through
   * `plugin.writerCreatePr(...)`. See {@link openProposalPr} for
   * the resolution rules.
   */
  plugins: PluginRegistry
  logger: Logger
}

export interface OpenedProposalPr {
  /** Provider-specific PR id (string — provider may not be numeric). */
  id: string
  /** Web URL of the opened PR. */
  url: string
  /** Plugin id that opened the PR (e.g. `'github'`, `'bitbucket'`). */
  provider: string
}

// ── Tenant writer ────────────────────────────────────────────────────────────

const DEFAULT_REF = DEFAULT_OVERLAY_REF

const BOOTSTRAP_COMMIT_MSG = 'chore(coro): bootstrap empty tenant intelligence repository'

/**
 * Ensure a full working clone of the tenant overlay exists at
 * `<writerCacheRoot>/<tenantId>/tenant/`, on the requested `ref`,
 * with no leftover state from previous runs.
 *
 * Strategy (kept simple on purpose):
 *   - First call:    `git clone <url> <dir>` (full clone — no `--depth`,
 *                    no `--single-branch`)
 *   - Subsequent:    `git fetch origin` + checkout + reset to
 *                    `origin/<baseRef>` where `baseRef` is the configured
 *                    ref if present, otherwise the remote default /
 *                    `main` / `master`. Empty remotes get a one-time
 *                    orphan bootstrap commit + push on `baseRef`.
 *                    (Any local proposal branches from
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
  const explicitRef = args.ref
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

  // Refresh remotes (all heads), resolve baseRef, optionally bootstrap an empty repo.
  const git = factory(dir)
  let baseRef: string
  try {
    await git.fetch('origin')

    let heads = await listOriginRemoteHeads(git)
    if (heads.length === 0) {
      const bootstrapRef = explicitRef ?? DEFAULT_REF
      await bootstrapEmptyTenantRemote(dir, git, bootstrapRef, logger)
      await git.fetch('origin')
      heads = await listOriginRemoteHeads(git)
      if (heads.length === 0) {
        throw new Error('remote still has no branches after bootstrap push')
      }
    }

    baseRef = await resolveOverlayBaseRef(git, heads, explicitRef)

    const branches = await git.branchLocal()
    if (branches.all.includes(baseRef)) {
      await git.checkout(baseRef)
    } else {
      await git.checkout(['-b', baseRef, `origin/${baseRef}`])
    }
    await git.reset(['--hard', `origin/${baseRef}`])
  } catch (err) {
    const refLabel = explicitRef ?? '(auto)'
    logger.error({ err, tenantId, url, ref: refLabel }, 'Failed to refresh tenant writer clone')
    throw new Error(
      `Failed to refresh tenant writer clone at ${dir} (ref=${refLabel}): ${(err as Error).message}`,
    )
  }

  return { dir, baseRef, remoteUrl: url }
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
  const baseRef = args.baseRef ?? (await detectOriginDefaultBranch(git)) ?? DEFAULT_REF

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
  const stagedPaths: string[] = []
  for (const file of files) {
    const normalised = file.path.replace(/^\.\//, '').trim()
    const abs = path.resolve(dir, normalised)
    const rel = path.relative(dir, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`commitAndPush: file path "${file.path}" escapes the writer dir`)
    }
    if (!normalised.toLowerCase().endsWith('.md')) {
      throw new Error(
        `commitAndPush: refusing to stage "${file.path}" — proposal commits are markdown-only.`,
      )
    }
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, file.content, 'utf-8')
    stagedPaths.push(normalised)
  }

  // Stage ONLY the declared proposal paths. Never `git add .` — the writer
  // dir is often the live job repo checkout and may contain gocache/, build
  // logs, test output, and other artefacts from earlier agent phases.
  for (const relPath of stagedPaths) {
    await git.add(relPath)
  }

  // Detect "no changes" — happens if the agent proposed content identical
  // to what already lives on baseRef. Treat as a clean no-op.
  const status = await git.status()
  const unexpected = [
    ...status.staged,
    ...status.created,
    ...status.modified,
  ].filter(p => !stagedPaths.includes(p.replace(/^\.\//, '')))
  if (unexpected.length > 0) {
    throw new Error(
      `commitAndPush: refusing to commit — unexpected paths would be included: ${unexpected.join(', ')}. ` +
        `Only files declared in propose_change are allowed.`,
    )
  }
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
 * Open a PR for the just-pushed branch. Dispatch is plugin-driven:
 *
 *   1. Parse `remoteUrl` to recover `{ host, owner, repoSlug }`.
 *   2. Ask the plugin registry which SCM plugin recognises that
 *      remote (`PluginRegistry.resolveByRemote(remoteUrl)`) — every
 *      SCM plugin implements `matchesRemote(...)` so this is fast
 *      and deterministic.
 *   3. Invoke that plugin's `writerCreatePr(...)` (a writer-only
 *      escape hatch — see ScmPluginRuntime.writerCreatePr docs).
 *      Plugins without a usable PR-creation path (e.g. an MCP-mode
 *      plugin that hasn't kept any inline native client) opt out by
 *      omitting the method, and we fail loudly with a remediation
 *      message rather than silently dropping the proposal.
 *
 * Why not use the SDK's MCP client to invoke
 * `mcp__<pluginId>__create_pull_request` directly?
 *   The writer runs in the runner's main event loop, **outside** any
 *   `query()` session. The Claude Agent SDK only exposes MCP tools
 *   inside a `query()` tool-use loop today. Until that lands as a
 *   standalone API, MCP-mode plugins keep a tiny native fallback
 *   (re-using the inline client they already need for `pollPr`)
 *   exposed as `writerCreatePr` and we route through it here.
 */
export async function openProposalPr(
  args: OpenProposalPrArgs,
): Promise<OpenedProposalPr> {
  const { remoteUrl, branch, baseRef, title, body, reviewerUsernames, plugins, logger } = args

  const parsed = parseRepoUrl(remoteUrl)
  if (!parsed) {
    throw new Error(`openProposalPr: cannot parse repo URL "${remoteUrl}"`)
  }

  const scm = plugins.resolveByRemote(remoteUrl)
  if (!scm) {
    throw new Error(
      `openProposalPr: no SCM plugin recognises remote "${remoteUrl}". ` +
      `Install or configure an SCM plugin (e.g. github, bitbucket) whose ` +
      `matchesRemote() returns true for this host before shipping proposals.`,
    )
  }

  if (typeof scm.writerCreatePr !== 'function') {
    throw new Error(
      `openProposalPr: SCM plugin "${scm.manifest.id}" does not implement ` +
      `writerCreatePr — proposal PRs cannot be opened against ${remoteUrl}. ` +
      `MCP-mode plugins must keep a writer-only native fallback because the ` +
      `runner cannot invoke MCP tools outside an active query() session today.`,
    )
  }

  const ref = await scm.writerCreatePr({
    repoSlug: parsed.repoSlug,
    title,
    description: body,
    sourceBranch: branch,
    targetBranch: baseRef,
    ...(reviewerUsernames && reviewerUsernames.length > 0 ? { reviewers: reviewerUsernames } : {}),
  })

  if (!ref.url) {
    // Without a URL the proposal record on the dashboard would be
    // useless — fail loudly so plugin authors notice.
    throw new Error(
      `openProposalPr: SCM plugin "${scm.manifest.id}" returned no PR URL. ` +
      `writerCreatePr must populate ExternalRef.url for the dashboard to link the proposal.`,
    )
  }

  const provider = scm.manifest.id
  logger.info({ prId: ref.externalId, url: ref.url, branch, provider }, 'Opened proposal PR')
  return { id: ref.externalId, url: ref.url, provider }
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

async function bootstrapEmptyTenantRemote(
  dir: string,
  git: SimpleGit,
  ref: string,
  logger: Logger,
): Promise<void> {
  await git.raw(['checkout', '--orphan', ref])

  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.git') continue
    await fs.rm(path.join(dir, entry.name), { recursive: true, force: true })
  }

  await fs.writeFile(path.join(dir, '.gitkeep'), '', 'utf-8')
  await git.add('.')
  await git.commit(BOOTSTRAP_COMMIT_MSG)
  await git.push('origin', ref, ['--set-upstream'])
  logger.info({ ref }, 'Bootstrapped empty tenant overlay remote')
}

async function isGitRepo(dir: string): Promise<boolean> {
  const stat = await fs.stat(path.join(dir, '.git')).catch(() => null)
  return stat?.isDirectory() ?? false
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
