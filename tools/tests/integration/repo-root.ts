import fs from 'fs'
import path from 'path'

/**
 * Resolves the a5-ai repository root whether tests are run from `tools/` or repo root.
 */
export function resolveA5aiRoot(): string {
  const candidates = [process.cwd(), path.join(process.cwd(), '..')]
  for (const dir of candidates) {
    const marker = path.join(dir, 'workflows', 'migration', 'workflow.md')
    if (fs.existsSync(marker)) return path.resolve(dir)
  }
  throw new Error(
    'Could not locate a5-ai repo root (expected workflows/migration/workflow.md). ' +
      'Run tests from the tools/ directory or the repository root.',
  )
}
