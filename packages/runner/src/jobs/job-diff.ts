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
   * Max bytes of unified-diff text to return. Protects the runner and the
   * dashboard from multi-megabyte payloads on accidental huge diffs. The
   * `files`/`stats` summary is always complete; only `patch` is capped.
   */
  maxPatchBytes?: number
}

const DEFAULT_BASE = 'main'
const DEFAULT_MAX_PATCH_BYTES = 2_000_000

function emptyDiff(base: string, available: boolean): JobDiff {
  return {
    base,
    head: 'HEAD',
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

async function isGitRepo(repoDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(repoDir, '.git'))
    return stat.isDirectory() || stat.isFile() // .git can be a file for worktrees
  } catch {
    return false
  }
}

const SHA_RE = /^[0-9a-f]{7,64}$/

/** Resolve a base ref that actually exists locally, preferring the bare name. */
async function resolveBaseRef(git: SimpleGit, base: string): Promise<string | null> {
  for (const ref of [base, `origin/${base}`]) {
    // `--verify --quiet` prints the commit sha on success and exits non-zero
    // with empty output when the ref is missing. simple-git does not reliably
    // throw on the quiet non-zero exit, so we validate the stdout instead of
    // relying on a thrown error.
    const out = await git.raw(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => '')
    if (SHA_RE.test(out.trim())) return ref
  }
  return null
}

/**
 * Compute the job diff for a cloned repo. Pure read-only git plumbing; safe to
 * call repeatedly (the dashboard polls it while the Changes tab is open).
 */
export async function computeJobDiff(opts: ComputeJobDiffOptions): Promise<JobDiff> {
  const base = opts.base?.trim() || DEFAULT_BASE
  const maxPatchBytes = opts.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES

  if (!(await isGitRepo(opts.repoDir))) {
    return emptyDiff(base, false)
  }

  const git = simpleGit({ baseDir: opts.repoDir })

  const baseRef = await resolveBaseRef(git, base)
  if (!baseRef) {
    // Repo exists but the base branch isn't here yet (e.g. brand-new clone
    // before the work-item branch diverges). Nothing to show, but available.
    return emptyDiff(base, true)
  }

  // Diff from the branch point so unrelated commits already on `base` don't
  // leak into the preview. Fall back to the base ref itself if merge-base
  // fails (e.g. unrelated histories).
  let from = baseRef
  try {
    const mb = (await git.raw(['merge-base', baseRef, 'HEAD'])).trim()
    if (mb) from = mb
  } catch {
    // keep baseRef
  }

  // One summary spawn for the file list + stats (always complete).
  const summary = await git.diffSummary([from])
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
    return { base: baseRef, head: 'HEAD', available: true, stats, files, patch: '', truncated: false }
  }

  // One patch spawn. Rename detection (-M) keeps the unified diff readable;
  // the frontend parser tolerates the standard `diff --git` section format.
  const rawPatch = await git.diff(['-M', from])
  let patch = rawPatch
  let truncated = false
  if (Buffer.byteLength(patch, 'utf-8') > maxPatchBytes) {
    patch = patch.slice(0, maxPatchBytes)
    truncated = true
  }

  return { base: baseRef, head: 'HEAD', available: true, stats, files, patch, truncated }
}
