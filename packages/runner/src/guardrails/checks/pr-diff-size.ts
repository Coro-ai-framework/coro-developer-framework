import path from 'node:path'
import fs from 'node:fs/promises'
import { simpleGit } from 'simple-git'
import type { GuardrailCheckFn } from '../types'

export interface PrDiffSizeConfig {
  maxLines?: number
  maxFiles?: number
  base?: string
}

export const checkPrDiffSize: GuardrailCheckFn = async (rule, ctx) => {
  const cfg = (rule.config ?? {}) as PrDiffSizeConfig
  const maxLines = typeof cfg.maxLines === 'number' ? cfg.maxLines : 500
  const maxFiles = typeof cfg.maxFiles === 'number' ? cfg.maxFiles : 40
  const base = typeof cfg.base === 'string' && cfg.base.length > 0 ? cfg.base : 'main'

  if (!ctx.repoDir) {
    return {
      allow: false,
      reason:
        'Cannot evaluate PR diff size: target repository is not checked out in the job working directory. ' +
        'Clone the repo first, then open the PR.',
    }
  }

  try {
    const stat = await fs.stat(path.join(ctx.repoDir, '.git'))
    if (!stat.isDirectory()) {
      return { allow: false, reason: 'Cannot evaluate PR diff size: repository has no .git directory.' }
    }
  } catch {
    return { allow: false, reason: 'Cannot evaluate PR diff size: repository path is missing.' }
  }

  const stat = await ctx.helpers.gitDiff({ repoDir: ctx.repoDir, base })
  if (stat.lines > maxLines || stat.files > maxFiles) {
    return {
      allow: false,
      reason:
        `PR diff is too large (${stat.lines} lines, ${stat.files} files; limit ${maxLines} lines / ${maxFiles} files ` +
        `against ${base}). Split the work into smaller PRs (one per work item) and retry.`,
    }
  }

  return { allow: true }
}

/** Shared helper for built-in and script guardrails. */
export async function gitDiffStat(repoDir: string, base = 'main'): Promise<{ lines: number; files: number }> {
  const git = simpleGit({ baseDir: repoDir })
  const summary = await git.diffSummary([`${base}...HEAD`])
  let lines = 0
  let files = 0
  for (const file of summary.files) {
    files += 1
    const change = file as { insertions?: number; deletions?: number }
    lines += (change.insertions ?? 0) + (change.deletions ?? 0)
  }
  return { lines, files }
}
