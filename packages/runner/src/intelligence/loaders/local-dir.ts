// ── Tenant overlay loader: localDir ──────────────────────────────────────────
//
// Source variant:  { kind: 'localDir', path: string }
//
// Used when a tenant's overlay lives on the same machine as the runner
// (single-host setups, dev-time iteration on company-specific
// intelligence). The loader simply validates that `path` exists and is
// a directory; the caller (resolver) handles copying it into the
// per-job overlay.

import * as fs from 'node:fs/promises'

import type { Logger } from 'pino'

export interface LocalDirLoaderArgs {
  path: string
  logger: Logger
}

/**
 * Resolve a `localDir` tenant overlay source to an absolute path on
 * disk. Returns `null` if the path does not exist or is not a
 * directory; the resolver treats `null` as "skip this layer" and logs
 * a warning so misconfiguration is visible.
 */
export async function loadLocalDirOverlay(
  args: LocalDirLoaderArgs,
): Promise<string | null> {
  const { path: dir, logger } = args

  if (!dir) {
    logger.warn('localDir tenant overlay has empty path — skipping')
    return null
  }

  const stat = await fs.stat(dir).catch(() => null)
  if (!stat) {
    logger.warn({ path: dir }, 'localDir tenant overlay path does not exist — skipping')
    return null
  }
  if (!stat.isDirectory()) {
    logger.warn({ path: dir }, 'localDir tenant overlay path is not a directory — skipping')
    return null
  }

  return dir
}
