// ── Per-job diff computation ─────────────────────────────────────────────────
//
// Computes the set of changes the agent has made in the cloned target repo,
// relative to the base branch. Powers the dashboard "Changes" tab and the
// pre-PR preview gate: developers can see exactly what a job is building
// before any PR is opened on the SCM.
//
// The diff is taken from the merge-base of `base..HEAD` against the current
// working tree, so it covers committed work-item changes *and* uncommitted
// edits-in-progress (matching "what the PR will contain"). It is read-only:
// it never mutates the index or working tree.

import fs from 'node:fs/promises'
import path from 'node:path'
import { simpleGit, type SimpleGit } from 'simple-git'
import type { Job } from '@coro-ai/cloud-protocol'

export interface JobDiffFile {
  /** Repo-relative path. */
  path: string
  insertions: number
  deletions: number
  binary: boolean
}

export interface JobDiff {
  /** The base ref the diff was computed against (e.g. `main` or `origin/main`). */
  base: string
  /** Always `HEAD` plus working-tree changes. */
  head: string
  /**
   * `false` when the repo is not cloned yet (or has no git history) — the
   * dashboard renders an empty/"nothing yet" state rather than an error.
   */
  available: boolean
  stats: { files: number; insertions: number; deletions: number }
  files: JobDiffFile[]
  /** Unified diff text (`git diff`). May be empty when there are no changes. */
  patch: string
  /** `true` when `patch` was truncated to stay under the size cap. */
  truncated: boolean
}

export interface ComputeJobDiffOptions {
  repoDir: string
  /** Base branch to diff against. Defaults to `main`. */
  base?: string
  /**
   * Branch/ref whose changes to show. Defaults to `HEAD` (the working tree,
   * including uncommitted edits). Pass a specific work-item branch to scope the
   * diff to that pushed PR preview — when it is *not* the currently checked-out
   * branch, the diff is taken commit-to-commit (no working-tree edits leak in).
   */
  head?: string
  /**
   * Max bytes of unified-diff text to return. Protects the runner and the
   * dashboard from multi-megabyte payloads on accidental huge diffs. The
   * `files`/`stats` summary is always complete; only `patch` is capped.
   */
  maxPatchBytes?: number
}

const DEFAULT_BASE = 'main'
const DEFAULT_MAX_PATCH_BYTES = 2_000_000

function emptyDiff(base: string, available: boolean, head = 'HEAD'): JobDiff {
  return {
    base,
    head,
    available,
    stats: { files: 0, insertions: 0, deletions: 0 },
    files: [],
    patch: '',
    truncated: false,
  }
}

/** Empty diff for the "repo not cloned yet" case (not computable -> unavailable). */
export function emptyJobDiff(base?: string): JobDiff {
  return emptyDiff(base?.trim() || DEFAULT_BASE, false)
}

/** Derive the base branch to diff against from the job's params. */
export function defaultBaseBranch(job: Job): string {
  const params = job.params as Record<string, unknown>
  for (const key of ['targetBranch', 'baseBranch', 'defaultBranch']) {
    const value = params[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return DEFAULT_BASE
}

/**
 * Resolve the base branch for the diff, honouring (in order):
 *   1. an explicit `?base=` query override,
 *   2. the base recorded on the *latest* `pr-preview` artifact — this is the
 *      branch the current work item targets (usually `main`, but a stacked PR
 *      may target a previous work-item branch),
 *   3. the job params default.
 *
 * Using the latest preview's base keeps the Changes tab anchored to the work
 * item the agent is *currently* on, rather than guessing across work items.
 */
export function resolveDiffBase(job: Job, override?: string): string {
  if (override && override.trim()) return override.trim()
  const artifacts = Array.isArray(job.artifacts) ? job.artifacts : []
  for (let i = artifacts.length - 1; i >= 0; i--) {
    const a = artifacts[i]
    if (a?.kind !== 'pr-preview') continue
    const data = a.data as Record<string, unknown> | undefined
    const base = data?.['base']
    if (typeof base === 'string' && base.trim()) return base.trim()
    break // newest preview found but it carried no base — fall through to params
  }
  return defaultBaseBranch(job)
}

async function isGitRepo(repoDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(repoDir, '.git'))
    return stat.isDirectory() || stat.isFile() // .git can be a file for worktrees
  } catch {
    return false
  }
}

const SHA_RE = /^[0-9a-f]{7,64}$/

/** True when a ref resolves to a commit in this repo. */
async function refExists(git: SimpleGit, ref: string): Promise<boolean> {
  // `--verify --quiet` prints the commit sha on success and exits non-zero with
  // empty output when the ref is missing. simple-git does not reliably throw on
  // the quiet non-zero exit, so we validate the stdout instead of relying on a
  // thrown error.
  const out = await git.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => '')
  return SHA_RE.test(out.trim())
}

/**
 * Resolve a base ref that actually exists locally.
 *
 * The remote-tracking ref (`origin/<base>`) is preferred over the local branch
 * because it reflects what the PR will actually diff against on the SCM. This
 * matters for multi-work-item jobs: each work item's PR is merged *server-side*
 * (via `scm_merge_pr`), so the local `main` is stale, but `origin/main` tracks
 * the merged tip once the coder fetches before branching the next work item.
 * Preferring it means an already-merged work item's commits don't leak into the
 * next work item's preview. If the bare name happens to be ahead (no remote, or
 * a local-only checkout), it is used as the fallback.
 */
async function resolveBaseRef(git: SimpleGit, base: string): Promise<string | null> {
  // Don't double-prefix an already-qualified remote ref like `origin/main`.
  const candidates = base.includes('/') ? [base] : [`origin/${base}`, base]
  for (const ref of candidates) {
    if (await refExists(git, ref)) return ref
  }
  return null
}

/**
 * Resolve a head ref (a work-item branch). The *local* branch is preferred over
 * the remote-tracking ref because it carries the agent's latest commits before
 * they are necessarily pushed.
 */
async function resolveHeadRef(git: SimpleGit, head: string): Promise<string | null> {
  const candidates = head.includes('/') ? [head] : [head, `origin/${head}`]
  for (const ref of candidates) {
    if (await refExists(git, ref)) return ref
  }
  return null
}

/**
 * Compute the job diff for a cloned repo. Pure read-only git plumbing; safe to
 * call repeatedly (the dashboard polls it while the Changes tab is open).
 */
export async function computeJobDiff(opts: ComputeJobDiffOptions): Promise<JobDiff> {
  const base = opts.base?.trim() || DEFAULT_BASE
  const headInput = opts.head?.trim() || 'HEAD'
  const maxPatchBytes = opts.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES

  if (!(await isGitRepo(opts.repoDir))) {
    return emptyDiff(base, false, headInput)
  }

  const git = simpleGit({ baseDir: opts.repoDir })

  const baseRef = await resolveBaseRef(git, base)
  if (!baseRef) {
    // Repo exists but the base branch isn't here yet (e.g. brand-new clone
    // before the work-item branch diverges). Nothing to show, but available.
    return emptyDiff(base, true, headInput)
  }

  // Resolve the head. `HEAD` (the default) diffs the working tree so in-progress
  // uncommitted edits show. A named branch that is *also* the checked-out branch
  // behaves the same (working tree included); any other branch is diffed
  // commit-to-commit so a pushed preview shows exactly what its PR will contain.
  let headRef = 'HEAD'
  let includeWorkingTree = true
  if (headInput !== 'HEAD') {
    const resolved = await resolveHeadRef(git, headInput)
    if (!resolved) {
      // Requested work-item branch not in this checkout yet — available, empty.
      return emptyDiff(base, true, headInput)
    }
    const current = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD')).trim()
    const isCheckedOut = current !== 'HEAD' && (resolved === current || resolved === `origin/${current}`)
    if (!isCheckedOut) {
      headRef = resolved
      includeWorkingTree = false
    }
  }

  // Diff from the branch point so unrelated commits already on `base` don't
  // leak into the preview. Fall back to the base ref itself if merge-base
  // fails (e.g. unrelated histories).
  let from = baseRef
  try {
    const mb = (await git.raw(['merge-base', baseRef, headRef])).trim()
    if (mb) from = mb
  } catch {
    // keep baseRef
  }

  // Working-tree diffs pass only `from` (compares against the index/worktree);
  // branch diffs pass `from headRef` for a commit-to-commit range.
  const diffRange = includeWorkingTree ? [from] : [from, headRef]

  // One summary spawn for the file list + stats (always complete).
  const summary = await git.diffSummary(diffRange)
  const files: JobDiffFile[] = summary.files.map(f => {
    const change = f as { file: string; insertions?: number; deletions?: number; binary?: boolean }
    return {
      path: change.file,
      insertions: change.insertions ?? 0,
      deletions: change.deletions ?? 0,
      binary: change.binary === true,
    }
  })
  const stats = {
    files: files.length,
    insertions: files.reduce((n, f) => n + f.insertions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  }

  if (files.length === 0) {
    return { base: baseRef, head: headInput, available: true, stats, files, patch: '', truncated: false }
  }

  // One patch spawn. Rename detection (-M) keeps the unified diff readable;
  // the frontend parser tolerates the standard `diff --git` section format.
  const rawPatch = await git.diff(['-M', ...diffRange])
  let patch = rawPatch
  let truncated = false
  if (Buffer.byteLength(patch, 'utf-8') > maxPatchBytes) {
    patch = patch.slice(0, maxPatchBytes)
    truncated = true
  }

  return { base: baseRef, head: headInput, available: true, stats, files, patch, truncated }
}
