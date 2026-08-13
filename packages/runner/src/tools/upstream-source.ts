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

export interface UpstreamSourceStamp {
  repo: string
  ref: string
  commit: string
  at: string
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
  const { cloneUrl, repo, ref, jobWorkingDir, logger } = args
  if (!cloneUrl) throw new Error('materialiseUpstreamSource: cloneUrl is required')
  if (!ref) throw new Error('materialiseUpstreamSource: ref is required')

  const absDir = path.join(jobWorkingDir, UPSTREAM_SOURCE_SUBDIR)
  const factory = args.gitFactory ?? ((cwd: string) => simpleGit({ baseDir: cwd }))

  const existing = await readStamp(absDir)
  if (existing && existing.ref === ref && existing.repo === repo) {
    return { ...existing, dir: UPSTREAM_SOURCE_SUBDIR, absDir, cloned: false }
  }

  await fs.rm(absDir, { recursive: true, force: true })
  await fs.mkdir(jobWorkingDir, { recursive: true })

  try {
    await factory(jobWorkingDir).clone(cloneUrl, absDir, [
      '--depth', '1',
      '--single-branch',
      '--branch', ref,
    ])

    // Read the revision before discarding `.git` — it is the only thing in
    // there worth keeping, and a finding that cannot name the revision it
    // checked is back to being a guess.
    const commit = (await factory(absDir).revparse(['HEAD'])).trim()
    await fs.rm(path.join(absDir, '.git'), { recursive: true, force: true })

    const stamp: UpstreamSourceStamp = { repo, ref, commit, at: new Date().toISOString() }
    await fs.writeFile(path.join(absDir, UPSTREAM_SOURCE_STAMP), `${JSON.stringify(stamp, null, 2)}\n`, 'utf-8')

    logger.info({ repo, ref, commit, absDir }, 'Materialised upstream source snapshot')
    return { ...stamp, dir: UPSTREAM_SOURCE_SUBDIR, absDir, cloned: true }
  } catch (err) {
    // Leave nothing half-cloned: a partial tree reads as a real snapshot to
    // the next caller and would be grepped as if it were complete.
    await fs.rm(absDir, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

async function readStamp(dir: string): Promise<UpstreamSourceStamp | null> {
  const raw = await fs.readFile(path.join(dir, UPSTREAM_SOURCE_STAMP), 'utf-8').catch(() => null)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<UpstreamSourceStamp>
    if (!parsed.repo || !parsed.ref || !parsed.commit) return null
    return { repo: parsed.repo, ref: parsed.ref, commit: parsed.commit, at: parsed.at ?? '' }
  } catch {
    return null
  }
}
