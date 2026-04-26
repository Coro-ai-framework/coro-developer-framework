import fs from 'fs'
import path from 'path'
import { getBaseLayerRoot } from '@coro/intelligence-base'

/**
 * Resolves the Coro intelligence root for tests.
 *
 * Production code reads the base intelligence from
 * `@coro/intelligence-base/layer/` via `getBaseLayerRoot()`, so tests do
 * the same — no more walking up looking for `./workflows/` at the repo
 * root (which no longer exists post-Phase-2).
 */
export function resolveIntelligenceRoot(): string {
  const root = getBaseLayerRoot()
  if (!fs.existsSync(path.join(root, 'workflows', 'job', 'workflow.md'))) {
    throw new Error(
      `Coro base intelligence layer is missing the canonical workflow ` +
        `marker (workflows/job/workflow.md) at ${root}. Did you delete or ` +
        `move @coro/intelligence-base/layer/?`,
    )
  }
  return root
}
