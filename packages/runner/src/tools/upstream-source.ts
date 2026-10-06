// ── Upstream source snapshot ─────────────────────────────────────────────────
//
// A retrospective forms its findings from job metrics. That is the right
// evidence for "the coder loops on Go test scaffolding", and no evidence at
// all for "…because the runner does not persist per-run cost" — a claim
// about a codebase the analyst has never read, on its way to a public issue
// where a maintainer has to correct it before they can act.
//
// This module puts that codebase in front of the analyst so the claim can be
// checked before it is published. Four properties are deliberate:
//
//   - **Upstream's default branch, not the version that ran.** The finding
//     is going upstream, so what matters is whether the defect is still
//     there on `main`. Verifying against the installed code would re-report
//     things maintainers already fixed.
//   - **A snapshot, not a checkout.** `.git` is removed once the revision
//     is recorded, so nothing can branch, commit, or push from the tree,
//     and the workspace/diff machinery cannot mistake it for the job's
//     target repo. A depth-1 clone has no history to lose.
//   - **Inside the job working directory.** The agent's file tools are
//     scoped to its cwd, so `grep -rn … _upstream/` just works, and the
//     tree is disposed of with the job rather than accumulating in a cache.
//   - **Authentication is the operator's**, exactly as in
//     `prepareUpstreamWriter`: the clone URL is used verbatim. The upstream
//     repository is public in the only configuration this feature is for,
//     and nothing here writes a credential into the job directory.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { Logger } from 'pino'
import { simpleGit, type SimpleGit } from 'simple-git'

/** Sub-directory under the per-job working tree holding the snapshot. */
export const UPSTREAM_SOURCE_SUBDIR = '_upstream'

/**
 * Written at the root of the snapshot because `.git` is gone by the time
 * anyone reads it. It is how a second call recognises an existing tree, and
 * how the analyst cites the revision it verified against.
 */
export const UPSTREAM_SOURCE_STAMP = '.coro-source.json'

/**
 * Sentinel recorded when the caller did not name a branch. A snapshot of
 * "whatever the remote default is" must not be reused as if it were an
 * explicit checkout of that same branch name.
 */
export const SOURCE_SNAPSHOT_DEFAULT_REF = 'default'

export interface UpstreamSourceStamp {
  repo: string
  /** Branch actually checked out. */
  ref: string
  commit: string
  at: string
  /**
   * What the caller asked for. {@link SOURCE_SNAPSHOT_DEFAULT_REF} when no
   * ref was given. Absent on stamps written before this field existed —
   * those are treated as an explicit request for `ref`.
   */
  requestedRef?: string
}

export interface UpstreamSourceSnapshot extends UpstreamSourceStamp {
  /** Job-dir-relative path — what the agent passes to grep. */
  dir: string
  absDir: string
  /** False when an existing snapshot was reused (a second call, a retry). */
  cloned: boolean
}

export interface MaterialiseUpstreamSourceArgs {
  /** Clone URL, used verbatim. */
  cloneUrl: string
  /** `owner/repo`, recorded in the stamp for provenance. */
  repo: string
  /** Branch to snapshot — the upstream default branch. */
  ref: string
  /** `<workingRoot>/<jobId>`; the snapshot lands directly beneath it. */
  jobWorkingDir: string
  logger: Logger
  /** Injection point for tests. */
  gitFactory?: (cwd: string) => SimpleGit
}

export interface SourceSnapshot extends UpstreamSourceStamp {
  absDir: string
  /** False when an existing snapshot was reused (a second call, a retry). */
  cloned: boolean
}

export interface MaterialiseSourceSnapshotArgs {
  /** Clone URL, used verbatim. */
  cloneUrl: string
  /** `owner/repo`, recorded in the stamp for provenance. */
  repo: string
  /**
   * Branch or tag to snapshot. Omit to clone the remote's default branch;
   * the resolved name is recorded on the stamp and the request is keyed as
   * {@link SOURCE_SNAPSHOT_DEFAULT_REF}.
   */
  ref?: string
  /** Absolute directory the snapshot is written to. Replaced on a ref mismatch. */
  destDir: string
  logger: Logger
  /** Injection point for tests. */
  gitFactory?: (cwd: string) => SimpleGit
  /** Appended to the clone arguments. Plan mode passes `--progress` so a stall timeout sees output. */
  extraCloneArgs?: string[]
  /** Overrides the info-log message. The upstream wrapper keeps its original wording. */
  logMessage?: string
}

/**
 * Ensure a read-only snapshot of `repo@ref` exists under the job working
 * directory, and report which revision it is.
 *
 * Idempotent within a run: a snapshot already on the requested ref is
 * reused, since a retrospective lasts minutes and re-cloning mid-run would
 * only invite two findings verified against different revisions. A stamp on
 * a different ref is discarded rather than reconciled.
 */
export async function materialiseUpstreamSource(
  args: MaterialiseUpstreamSourceArgs,
): Promise<UpstreamSourceSnapshot> {
  if (!args.cloneUrl) throw new Error('materialiseUpstreamSource: cloneUrl is required')
  if (!args.ref) throw new Error('materialiseUpstreamSource: ref is required')

  const snapshot = await materialiseSourceSnapshot({
    cloneUrl: args.cloneUrl,
    repo: args.repo,
    ref: args.ref,
    destDir: path.join(args.jobWorkingDir, UPSTREAM_SOURCE_SUBDIR),
    logger: args.logger,
    logMessage: 'Materialised upstream source snapshot',
    ...(args.gitFactory ? { gitFactory: args.gitFactory } : {}),
  })
  return { ...snapshot, dir: UPSTREAM_SOURCE_SUBDIR }
}

/**
 * Shallow, single-branch snapshot with `.git` removed.
 *
 * Shared by the retrospective's upstream checkout and plan mode's
 * `scm_checkout`. The caller owns where it lands (`destDir`) and how git
 * is spawned (`gitFactory`), so credentials and the host sandbox stay the
 * caller's problem. A second call reuses the tree only when the stamp
 * names the same repository and the same *request* — an explicit branch
 * is not the same request as "the remote default", even when both resolve
 * to that branch.
 */
export async function materialiseSourceSnapshot(
  args: MaterialiseSourceSnapshotArgs,
): Promise<SourceSnapshot> {
  const { cloneUrl, repo, destDir, logger } = args
  if (!cloneUrl) throw new Error('materialiseSourceSnapshot: cloneUrl is required')
  if (!repo) throw new Error('materialiseSourceSnapshot: repo is required')
  if (!destDir) throw new Error('materialiseSourceSnapshot: destDir is required')

  const ref = args.ref?.trim() || undefined
  const requestedRef = ref ?? SOURCE_SNAPSHOT_DEFAULT_REF
  const factory = args.gitFactory ?? ((cwd: string) => simpleGit({ baseDir: cwd }))

  const existing = await readStamp(destDir)
  if (existing && existing.repo === repo && stampRequest(existing) === requestedRef) {
    return { ...existing, absDir: destDir, cloned: false }
  }

  await fs.rm(destDir, { recursive: true, force: true })
  await fs.mkdir(path.dirname(destDir), { recursive: true })

  try {
    await factory(path.dirname(destDir)).clone(cloneUrl, destDir, [
      '--depth', '1',
      '--single-branch',
      ...(ref ? ['--branch', ref] : []),
      ...(args.extraCloneArgs ?? []),
    ])

    // Read the revision before discarding `.git` — it is the only thing in
    // there worth keeping, and a finding that cannot name the revision it
    // checked is back to being a guess.
    const git = factory(destDir)
    const commit = (await git.revparse(['HEAD'])).trim()
    const resolvedRef = ref ?? await resolveDefaultBranch(git)
    await fs.rm(path.join(destDir, '.git'), { recursive: true, force: true })

    const stamp: UpstreamSourceStamp = {
      repo,
      ref: resolvedRef,
      commit,
      at: new Date().toISOString(),
      requestedRef,
    }
    await fs.writeFile(path.join(destDir, UPSTREAM_SOURCE_STAMP), `${JSON.stringify(stamp, null, 2)}\n`, 'utf-8')

    logger.info(
      { repo, ref: resolvedRef, requestedRef, commit, absDir: destDir },
      args.logMessage ?? 'Materialised source snapshot',
    )
    return { ...stamp, absDir: destDir, cloned: true }
  } catch (err) {
    // Leave nothing half-cloned: a partial tree reads as a real snapshot to
    // the next caller and would be grepped as if it were complete.
    await fs.rm(destDir, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

async function resolveDefaultBranch(git: SimpleGit): Promise<string> {
  const resolved = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()
  if (!resolved || resolved === 'HEAD') {
    throw new Error('materialiseSourceSnapshot: could not resolve the default branch')
  }
  return resolved
}

function stampRequest(stamp: UpstreamSourceStamp): string {
  return stamp.requestedRef ?? stamp.ref
}

async function readStamp(dir: string): Promise<UpstreamSourceStamp | null> {
  const raw = await fs.readFile(path.join(dir, UPSTREAM_SOURCE_STAMP), 'utf-8').catch(() => null)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<UpstreamSourceStamp>
    if (!parsed.repo || !parsed.ref || !parsed.commit) return null
    return {
      repo: parsed.repo,
      ref: parsed.ref,
      commit: parsed.commit,
      at: parsed.at ?? '',
      ...(parsed.requestedRef ? { requestedRef: parsed.requestedRef } : {}),
    }
  } catch {
    return null
  }
}
