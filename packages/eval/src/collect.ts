import fs from 'node:fs'
import path from 'node:path'
import type { Job } from '@coro-ai/cloud-protocol'
import { git, gitResult, isAncestor, revParse } from './git'
import type { Delivery } from './types'

/**
 * Work out what the job delivered, and write down the evidence.
 *
 * With the local SCM plugin the deliverable is a branch (or several, one per
 * work item) pushed into the sandbox repository, and the simulated reviewer
 * merges those into `main` as the job marks each pull request merged. So:
 *
 *   - If `main` moved, that is the deliverable (`via: 'merged'`).
 *   - If it did not, but the job pushed branches (it failed, timed out or
 *     escalated after opening a PR), those branches are combined on top of
 *     the base commit (`via: 'branches'`). A branch that conflicts with the
 *     others is skipped and reported, never silently dropped.
 *
 * Either way the result is pinned to a branch named `eval/delivered`, which is
 * the one thing grading ever checks out.
 */

export const DELIVERED_BRANCH = 'eval/delivered'

export async function saveJob(job: Job, dir: string): Promise<void> {
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job, null, 2))
}

/** Branch names the job announced in `pr-preview` artefacts, oldest first. */
export function announcedBranches(job: Job | undefined): string[] {
  const names: string[] = []
  for (const artifact of job?.artifacts ?? []) {
    if (artifact.kind !== 'pr-preview') continue
    const branch = artifact.data?.['sourceBranch']
    if (typeof branch === 'string' && branch && !names.includes(branch)) names.push(branch)
  }
  return names
}

async function listBranches(sandbox: string): Promise<string[]> {
  const out = await git(['for-each-ref', '--sort=committerdate', '--format=%(refname:short)', 'refs/heads'], sandbox)
  return out
    .split('\n')
    .map(line => line.trim())
    .filter(name => name && name !== 'main' && !name.startsWith('eval/'))
}

async function commitsAhead(sandbox: string, base: string, branch: string): Promise<number> {
  const out = await gitResult(['rev-list', '--count', `${base}..${branch}`], sandbox)
  return out.code === 0 ? Number.parseInt(out.stdout.trim(), 10) || 0 : 0
}

export async function collectDelivery(args: { sandbox: string; baseSha: string; job?: Job }): Promise<Delivery> {
  const { sandbox, baseSha } = args
  const none: Delivery = { delivered: false, baseSha, branches: [], skippedBranches: [] }

  const candidates = await listBranches(sandbox)
  // Announced branches first, in announcement order; any others the job pushed after them.
  const announced = announcedBranches(args.job).filter(name => candidates.includes(name))
  const ordered = [...announced, ...candidates.filter(name => !announced.includes(name))]
  const withWork: string[] = []
  for (const branch of ordered) {
    if ((await commitsAhead(sandbox, baseSha, branch)) > 0) withWork.push(branch)
  }

  const mainSha = await revParse(sandbox, 'refs/heads/main')
  if (mainSha && mainSha !== baseSha) {
    await git(['branch', '-f', DELIVERED_BRANCH, mainSha], sandbox)
    const merged: string[] = []
    for (const branch of withWork) {
      if (await isAncestor(sandbox, branch, 'main')) merged.push(branch)
    }
    return {
      delivered: true,
      baseSha,
      headSha: mainSha,
      via: 'merged',
      branches: merged,
      skippedBranches: withWork.filter(branch => !merged.includes(branch)),
    }
  }

  if (withWork.length === 0) return none

  // Nothing was merged. Combine whatever was pushed on a throwaway branch.
  await git(['checkout', '--quiet', '-B', DELIVERED_BRANCH, baseSha], sandbox)
  const combined: string[] = []
  const skipped: string[] = []
  for (const branch of withWork) {
    const merge = await gitResult(['merge', '--no-ff', '--no-edit', branch], sandbox)
    if (merge.code === 0) {
      combined.push(branch)
    } else {
      await gitResult(['merge', '--abort'], sandbox)
      skipped.push(branch)
    }
  }
  const headSha = (await git(['rev-parse', 'HEAD'], sandbox)).trim()
  await git(['checkout', '--quiet', 'main'], sandbox)

  if (combined.length === 0) return { ...none, skippedBranches: skipped }
  return { delivered: true, baseSha, headSha, via: 'branches', branches: combined, skippedBranches: skipped }
}

/** The unified diff from the fixture to the delivered commit. Empty when nothing was delivered. */
export async function deliveredDiff(sandbox: string, delivery: Delivery): Promise<string> {
  if (!delivery.delivered || !delivery.headSha) return ''
  return git(['diff', '--no-color', '--no-ext-diff', '--no-renames', delivery.baseSha, delivery.headSha], sandbox)
}

/** `git diff --numstat` rows for the delivered change, as `added<TAB>removed<TAB>file`. */
export async function deliveredNumstat(sandbox: string, delivery: Delivery): Promise<string> {
  if (!delivery.delivered || !delivery.headSha) return ''
  return git(['diff', '--numstat', '--no-renames', delivery.baseSha, delivery.headSha], sandbox)
}
