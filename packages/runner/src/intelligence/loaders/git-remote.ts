// ── Tenant overlay loader: gitRemote ─────────────────────────────────────────
//
// Source variant:  { kind: 'gitRemote', url: string, ref?: string }
//
// Used when a tenant's overlay is versioned in a git repository (the
// most common setup for teams that already track intelligence
// alongside other infrastructure-as-code).
//
// Caching strategy:
//   - First fetch:  `git clone --depth 1 [--branch <ref>] <url> <cacheDir>`
//   - Subsequent:   `git fetch --depth 1 origin <ref>` + hard reset
//
// The cache lives under `<cacheRoot>/<tenantId>/` so tenants with
// different overlays cannot collide. The caller (resolver) supplies
// `cacheRoot` so tests can use a temp dir without touching `~/.coro/`.
//
// Authentication: the URL is used verbatim. SSH URLs use the agent /
// key on the runner host; HTTPS URLs can include `user:token@` inline.
// We deliberately do NOT inject credentials — that's the operator's
// responsibility, same as for the target-repo clone.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { Logger } from 'pino'
import { simpleGit, type SimpleGit } from 'simple-git'

export interface GitRemoteLoaderArgs {
  url: string
  ref?: string
  /** Stable identifier; used as the cache subdirectory name. */
  tenantId: string
  /** Root under which loader caches per tenant. */
  cacheRoot: string
  logger: Logger
  /** Optional injection point for tests. */
  gitFactory?: (cwd: string) => SimpleGit
}

/** Default branch when a tenant doesn't pin one. */
const DEFAULT_REF = 'main'

/**
 * Resolve a `gitRemote` tenant overlay source by ensuring a local
 * checkout of `url@ref` exists at a stable cache path, then returning
 * that path. Returns `null` on hard failure (network down, bad URL),
 * with a warning logged — the resolver treats `null` as "skip this
 * layer" so a transient git failure cannot stall jobs.
 */
export async function loadGitRemoteOverlay(
  args: GitRemoteLoaderArgs,
): Promise<string | null> {
  const { url, ref, tenantId, cacheRoot, logger } = args
  const targetRef = ref ?? DEFAULT_REF
  const factory = args.gitFactory ?? ((cwd: string) => simpleGit({ baseDir: cwd }))

  if (!url) {
    logger.warn({ tenantId }, 'gitRemote tenant overlay has empty url — skipping')
    return null
  }
  if (!tenantId) {
    logger.warn('gitRemote tenant overlay missing tenantId — skipping')
    return null
  }

  const cacheDir = path.join(cacheRoot, tenantId)
  await fs.mkdir(path.dirname(cacheDir), { recursive: true })

  const exists = await isGitRepo(cacheDir)
  try {
    if (!exists) {
      await fs.rm(cacheDir, { recursive: true, force: true })
      const parent = path.dirname(cacheDir)
      await fs.mkdir(parent, { recursive: true })
      const git = factory(parent)
      await git.clone(url, cacheDir, ['--depth', '1', '--branch', targetRef, '--single-branch'])
      logger.info({ tenantId, url, ref: targetRef, cacheDir }, 'Cloned tenant overlay (gitRemote)')
    } else {
      const git = factory(cacheDir)
      await git.fetch('origin', targetRef, ['--depth', '1'])
      await git.reset(['--hard', `origin/${targetRef}`])
      logger.info({ tenantId, url, ref: targetRef, cacheDir }, 'Refreshed tenant overlay (gitRemote)')
    }
  } catch (err) {
    logger.warn({ err, tenantId, url, ref: targetRef }, 'gitRemote tenant overlay fetch failed — skipping layer')
    return null
  }

  return cacheDir
}

async function isGitRepo(dir: string): Promise<boolean> {
  const stat = await fs.stat(path.join(dir, '.git')).catch(() => null)
  return stat?.isDirectory() ?? false
}
