import type { GuardrailCheckFn } from '../types'

function collectProposalPaths(toolInput: Record<string, unknown>): string[] {
  const paths: string[] = []
  const files = toolInput.files
  if (Array.isArray(files)) {
    for (const row of files) {
      if (row && typeof row === 'object' && typeof (row as { path?: unknown }).path === 'string') {
        paths.push((row as { path: string }).path)
      }
    }
  }
  const entries = toolInput.entries
  if (Array.isArray(entries)) {
    for (const row of entries) {
      if (row && typeof row === 'object' && typeof (row as { file?: unknown }).file === 'string') {
        paths.push((row as { file: string }).file)
      }
    }
  }
  const targetFile = toolInput.targetFile
  if (typeof targetFile === 'string' && targetFile.trim()) {
    paths.push(targetFile.trim())
  }
  return paths
}

function isMarkdownProposalPath(filePath: string): boolean {
  const normalised = filePath.replace(/^\.\//, '').trim()
  return normalised.toLowerCase().endsWith('.md')
}

/** Guardrail check: propose_change may only ship .md paths. */
export const checkProposalMarkdownOnly: GuardrailCheckFn = async (_rule, ctx) => {
  const paths = collectProposalPaths(ctx.toolInput)
  if (paths.length === 0) {
    return {
      allow: false,
      reason:
        'propose_change must include at least one file path (via files[] or entries[].file). ' +
        'Do not rely on git add — only declared .md paths are committed.',
    }
  }

  for (const p of paths) {
    if (!isMarkdownProposalPath(p)) {
      return {
        allow: false,
        reason:
          `Proposal path "${p}" must end with .md. Self-improvement PRs ship markdown only — ` +
          `never build logs, caches (gocache/), or other artefacts from the job working directory.`,
      }
    }
  }

  return { allow: true }
}
