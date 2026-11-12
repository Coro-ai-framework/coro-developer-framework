// ── Changed paths ────────────────────────────────────────────────────────────
//
// A job's working directory is not kept forever, and the dashboard's diff is
// computed on demand. Pull-request review wants to know which earlier jobs
// touched the files under review, so the paths are recorded on the job when
// its `pr-preview` artefact is posted, which is the first moment they are
// final for a work item.

import type { Job } from '@coro-ai/cloud-protocol'
import { deriveRepoCheckoutDir } from './helpers'
import { computeJobDiff } from './job-diff'

/** Enough for any real change; a job past this is a migration whose paths are not review input. */
export const MAX_RECORDED_PATHS = 400

/** Union of what is already recorded and what the preview changes, capped. */
export function mergeChangedPaths(existing: unknown, added: string[]): string[] {
  const merged = new Set<string>(Array.isArray(existing) ? existing.filter((item): item is string => typeof item === 'string') : [])
  for (const item of added) {
    if (merged.size >= MAX_RECORDED_PATHS) break
    merged.add(item)
  }
  return [...merged]
}

/**
 * Paths changed by the work item a `pr-preview` describes. Returns `[]`
 * when the checkout or branch is not there; nothing here may fail a job.
 */
export async function changedPathsForPreview(
  job: Job,
  workingRoot: string,
  preview: Record<string, unknown>,
): Promise<string[]> {
  const repoDir = deriveRepoCheckoutDir(job, workingRoot)
  if (!repoDir) return []
  const base = typeof preview['base'] === 'string' ? preview['base'] : undefined
  const head = typeof preview['sourceBranch'] === 'string' ? preview['sourceBranch'] : undefined
  try {
    const diff = await computeJobDiff({ repoDir, ...(base ? { base } : {}), ...(head ? { head } : {}), maxPatchBytes: 1 })
    return diff.files.map(file => file.path)
  } catch {
    return []
  }
}
