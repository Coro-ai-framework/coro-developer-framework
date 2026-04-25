import fs from 'fs'
import path from 'path'

/**
 * Resolves the Coro intelligence repo root whether tests are run from
 * `packages/runner/` or the workspace root.
 */
export function resolveIntelligenceRoot(): string {
  const candidates = [
    process.cwd(),
    path.join(process.cwd(), '..'),
    path.join(process.cwd(), '..', '..'),
  ]
  for (const dir of candidates) {
    const marker = path.join(dir, 'workflows', 'job', 'workflow.md')
    if (fs.existsSync(marker)) return path.resolve(dir)
  }
  throw new Error(
    'Could not locate Coro intelligence root (expected workflows/job/workflow.md). ' +
      'Run tests from packages/runner/ or the workspace root.',
  )
}
