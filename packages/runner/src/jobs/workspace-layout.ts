// ── Job workspace layout (language-agnostic) ─────────────────────────────────
//
// Paths for the per-job working directory vs the cloned target repo.
// Toolchain-specific build commands live in {language}-conventions skills.

import path from 'path'
import type { Job } from '@coro-ai/cloud-protocol'

export interface JobWorkspaceLayout {
  jobWorkingDir: string
  repoCheckoutDir?: string
  repoCheckoutAbsDir?: string
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

  return { jobWorkingDir, repoCheckoutDir: rel, repoCheckoutAbsDir: abs }
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
