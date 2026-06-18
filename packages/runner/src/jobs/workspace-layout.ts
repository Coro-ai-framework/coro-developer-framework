// ── Job workspace layout (language-agnostic) ─────────────────────────────────
//
// Paths for the per-job working directory vs the cloned target repo.
// Toolchain-specific build commands live in {language}-conventions skills.

import fs from 'node:fs/promises'
import path from 'path'
import type { Job } from '@coro-ai/cloud-protocol'

export interface JobWorkspaceLayout {
  jobWorkingDir: string
  repoCheckoutDir?: string
  repoCheckoutAbsDir?: string
  /** Present on campaign child jobs — relative path to copied parent context. */
  campaignContextDir?: string
}

export function resolveJobWorkspaceLayout(job: Job, jobWorkingDir: string): JobWorkspaceLayout {
  const params = job.params as Record<string, unknown>
  const rel =
    typeof params['repoCheckoutDir'] === 'string' ? params['repoCheckoutDir']
    : typeof params['repoSlug'] === 'string' ? params['repoSlug']
    : typeof params['repo'] === 'string' ? params['repo']
    : undefined

  const abs =
    typeof params['repoCheckoutAbsDir'] === 'string' ? params['repoCheckoutAbsDir']
    : rel ? path.join(jobWorkingDir, rel) : undefined

  const campaignContextDir = paramString(params, 'campaignContextDir')

  return { jobWorkingDir, repoCheckoutDir: rel, repoCheckoutAbsDir: abs, campaignContextDir }
}

function paramString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/**
 * Candidate repo directory names for the primary checkout (where code changes
 * and PRs land). Used by dashboard read paths (diff, open-in-editor) only.
 *
 * Migration jobs clone both `sourceRepo` (reference) and `targetRepo` (write).
 * `params.repoCheckoutDir` may still point at the source tree if that was the
 * last `scm_clone_repo` call — same priority idea as guardrails' targetRepo fallback.
 */
export function buildPrimaryRepoCandidates(job: Job): string[] {
  const params = (job.params ?? {}) as Record<string, unknown>
  const out: string[] = []
  const seen = new Set<string>()
  const add = (rel?: string) => {
    if (!rel || seen.has(rel)) return
    seen.add(rel)
    out.push(rel)
  }

  add(paramString(params, 'targetRepo'))
  for (const m of [...(job.prMappings ?? [])].reverse()) {
    add(m.repoSlug?.trim())
  }
  add(paramString(params, 'repoCheckoutDir'))
  add(paramString(params, 'repoSlug'))
  add(paramString(params, 'repo'))
  if (!paramString(params, 'targetRepo')) {
    add(paramString(params, 'sourceRepo'))
  }

  return out
}

async function isGitRepo(repoDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(repoDir, '.git'))
    return stat.isDirectory() || stat.isFile()
  } catch {
    return false
  }
}

/** Primary checkout for dashboard diff / open-in-editor (read-time resolution). */
export async function resolvePrimaryRepoCheckout(
  job: Job,
  jobWorkingDir: string,
): Promise<JobWorkspaceLayout> {
  for (const rel of buildPrimaryRepoCandidates(job)) {
    const abs = path.join(jobWorkingDir, rel)
    if (await isGitRepo(abs)) {
      return { jobWorkingDir, repoCheckoutDir: rel, repoCheckoutAbsDir: abs }
    }
  }
  return resolveJobWorkspaceLayout(job, jobWorkingDir)
}

/** System-prompt block: paths + skill pointer (no language-specific commands). */
export function buildWorkspaceLayoutPromptBlock(layout: JobWorkspaceLayout): string {
  const lines = [
    '## Workspace layout',
    '',
    `Job root: \`${layout.jobWorkingDir}\` — the executor may start Bash here.`,
  ]

  if (layout.repoCheckoutAbsDir && layout.repoCheckoutDir) {
    lines.push(
      `Repo: \`${layout.repoCheckoutAbsDir}\` — run git and toolchain commands from this tree.`,
      `Relative: \`${layout.repoCheckoutDir}\` — use \`cd ${layout.repoCheckoutDir} && …\` or \`git -C ${layout.repoCheckoutDir}\`.`,
      '',
      'Before compile or test commands, change into **Relative** (or use `git -C`).',
      'Build and test commands live in the **`{language}-conventions`** skill — invoke it via the Skill tool when `params.language` is set.',
    )
  } else {
    lines.push(
      '',
      'No target repo checkout is registered yet. Call `scm_clone_repo` first; paths will appear here after clone.',
    )
  }

  if (layout.campaignContextDir) {
    lines.push(
      '',
      `Campaign context: \`${layout.campaignContextDir}/\` under the job root — markdown/json copied from the parent campaign at dispatch. ` +
        'Read parent campaign inputs here; write campaign outputs here (the runner syncs this folder back to the parent when you finish). ' +
        'Path refs in `params` (e.g. `campaignDecisionsRef`) are already rewritten to this directory.',
    )
  }

  return lines.join('\n')
}

/** Phase kickoff reminder (paths + cd placeholder only). */
export function buildWorkspaceLayoutKickoffBlock(layout: JobWorkspaceLayout): string {
  if (!layout.repoCheckoutDir) return ''

  return [
    '',
    '## Workspace',
    `Repo checkout: \`${layout.repoCheckoutDir}\` (under job root).`,
    `Run git/toolchain from the repo: \`cd ${layout.repoCheckoutDir} && …\``,
    'Invoke the `{language}-conventions` skill for build/test commands.',
    '',
  ].join('\n')
}
