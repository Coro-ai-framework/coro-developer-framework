// ── Intelligence resolver (Phase 3 skeleton) ─────────────────────────────────
//
// The resolver materialises a per-job intelligence directory by stacking
// the layered intelligence model (base → tenant → repo) into a single
// on-disk overlay that the runner reads from for that job.
//
// Phase 3 scope (this file):
//   - Apply only the **base layer** (`@coro/intelligence-base/layer`)
//   - Produce a clean per-job dir at `<workingRoot>/<jobId>/_intelligence/`
//   - Return a `ResolvedIntelligence` describing which layers were applied
//
// Phase 4 (resolver-overlay) extends this with:
//   - `tenant` layer pulled from `TenantContext.overlay` (localDir / git /
//     cloudBlob), with last-wins semantics for `agents/`, `workflows/`,
//     `skills/` and concatenation for `.claude/CLAUDE.md` and `memory/`
//   - `repo` layer from `<repo>/.coro/` (per-repository overrides)
//
// Decoupling reasoning:
//   - The runner already has a process-wide `settings.paths.coroIntelligenceDir`
//     used by long-lived consumers (the file watcher, the HTTP server).
//     Those stay tenant-agnostic for now.
//   - Per-job consumers (workflow loader, prompt builder, subagent loader,
//     filesystem hooks) read from the resolved per-job dir so each job sees
//     its own coherent stack of layers.
//   - The output dir is always under `workingRoot/<jobId>/` so it is
//     cleaned up alongside the job's working tree.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { Logger } from 'pino'

import type { TenantContext } from './tenant-context'

/** Inputs to {@link resolveJobIntelligence}. */
export interface ResolveJobIntelligenceArgs {
  /** Absolute path to `@coro/intelligence-base/layer` for this runner. */
  baseLayerDir: string
  /** Tenant the job is being run for. */
  tenantContext: TenantContext
  /** Stable job identifier; used as the per-job sub-directory name. */
  jobId: string
  /**
   * Root under which per-job working trees live (typically
   * `settings.paths.workingDir`). The resolver creates
   * `<workingRoot>/<jobId>/_intelligence/`.
   */
  workingRoot: string
  /** Logger for resolver diagnostics. */
  logger: Logger
}

/** A single layer that was applied during resolution. */
export interface AppliedLayer {
  /** Human-readable identifier — e.g. `base`, `tenant:team-abc`, `repo`. */
  name: string
  /** Source directory the layer was copied from. */
  source: string
  /** Number of files contributed by this layer (post-overlay). */
  fileCount: number
}

/** Result of resolving a per-job intelligence stack. */
export interface ResolvedIntelligence {
  /** Absolute path to the materialised per-job intelligence directory. */
  intelligenceDir: string
  /** Layers applied, in apply order (base first, repo last). */
  layers: AppliedLayer[]
  /** The tenant the resolution was performed for. */
  tenantContext: TenantContext
}

/** Sub-directory under the per-job working tree where the overlay lives. */
export const JOB_INTELLIGENCE_SUBDIR = '_intelligence'

/**
 * Materialise the intelligence overlay for a single job.
 *
 * Phase 3 implements only the base layer; Phase 4 will append tenant and
 * repo overlays. The function is async and idempotent — calling it twice
 * for the same `jobId` re-creates the directory from scratch.
 */
export async function resolveJobIntelligence(
  args: ResolveJobIntelligenceArgs,
): Promise<ResolvedIntelligence> {
  const { baseLayerDir, tenantContext, jobId, workingRoot, logger } = args

  if (!jobId) {
    throw new Error('resolveJobIntelligence: jobId is required')
  }
  if (!baseLayerDir) {
    throw new Error('resolveJobIntelligence: baseLayerDir is required')
  }

  // Resolve to an absolute path so downstream consumers (SDK hooks, MCP
  // tools) never accidentally relative-resolve against a different cwd.
  const intelligenceDir = path.resolve(workingRoot, jobId, JOB_INTELLIGENCE_SUBDIR)

  // Always start from a clean slate. We do NOT preserve previous content
  // because layers are idempotent and any cached state on disk could mask
  // a config change between runs.
  await fs.rm(intelligenceDir, { recursive: true, force: true })
  await fs.mkdir(intelligenceDir, { recursive: true })

  const layers: AppliedLayer[] = []

  // Layer 1 — base. Always applied; ships with the runner.
  await copyDirectory(baseLayerDir, intelligenceDir)
  const baseFileCount = await countFiles(intelligenceDir)
  layers.push({ name: 'base', source: baseLayerDir, fileCount: baseFileCount })

  // Layer 2 — tenant overlay. Phase 4 will switch on `tenantContext.overlay.kind`.
  if (tenantContext.overlay.kind !== 'none') {
    logger.warn(
      { tenantId: tenantContext.tenantId, overlayKind: tenantContext.overlay.kind },
      'Tenant overlay declared but resolver has no overlay loader yet — skipping (Phase 4)',
    )
  }

  // Layer 3 — repo overlay. Phase 4 will read `<repo>/.coro/` if present.

  logger.info(
    {
      jobId,
      tenantId: tenantContext.tenantId,
      tenantMode: tenantContext.mode,
      intelligenceDir,
      layerCount: layers.length,
      baseFileCount,
    },
    'Resolved per-job intelligence overlay',
  )

  return { intelligenceDir, layers, tenantContext }
}

/**
 * Best-effort cleanup of a previously materialised job overlay. Safe to
 * call even if the directory has already been removed.
 */
export async function cleanupJobIntelligence(
  args: { workingRoot: string, jobId: string, logger: Logger },
): Promise<void> {
  const { workingRoot, jobId, logger } = args
  if (!jobId) return
  const intelligenceDir = path.resolve(workingRoot, jobId, JOB_INTELLIGENCE_SUBDIR)
  try {
    await fs.rm(intelligenceDir, { recursive: true, force: true })
  } catch (err) {
    logger.debug({ err, intelligenceDir }, 'cleanupJobIntelligence: rm failed (best-effort)')
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Recursive directory copy with overlay semantics: when `dest` already has
 * a file at the same relative path, the source overwrites it. Symlinks are
 * collapsed to their target file content. Empty directories from the
 * source are preserved.
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(src, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return // missing source layer is treated as empty
    throw err
  }

  await fs.mkdir(dest, { recursive: true })

  for (const entry of entries) {
    // Skip OS metadata files that occasionally land inside layer dirs.
    if (entry.name === '.DS_Store') continue

    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath)
    } else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(srcPath)
      const resolvedTarget = path.isAbsolute(target) ? target : path.join(src, target)
      const stat = await fs.stat(resolvedTarget).catch(() => null)
      if (stat?.isDirectory()) {
        await copyDirectory(resolvedTarget, destPath)
      } else if (stat?.isFile()) {
        await fs.copyFile(resolvedTarget, destPath)
      }
      // Broken symlinks are silently dropped — we never want to materialise them.
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath)
    }
  }
}

/** Count regular files under `root`, recursively. */
async function countFiles(root: string): Promise<number> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }

  let count = 0
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue
    const child = path.join(root, entry.name)
    if (entry.isDirectory()) {
      count += await countFiles(child)
    } else if (entry.isFile()) {
      count += 1
    }
  }
  return count
}
