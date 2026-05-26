// ── Intelligence resolver ────────────────────────────────────────────────────
//
// The resolver materialises a per-job intelligence directory by stacking
// the layered intelligence model into a single on-disk overlay that the
// runner reads from for that job:
//
//   1. base    — `@coro-ai/intelligence-base/layer/`         (always present)
//   2. tenant  — local dir / git remote / cloud blob       (per TenantContext)
//   3. repo    — `<repoCheckout>/.coro/`                   (per target repo)
//
// Merge semantics (see `merge.ts`):
//   - `replace` (last-wins) for  agents/, workflows/, .claude/skills/, etc.
//   - `append`  (with banners) for  .claude/CLAUDE.md  and  memory/**/*.md
//
// What the resolver intentionally does NOT do:
//   - touch `<repoCheckout>/.claude/`. That lives at the SDK's `cwd` and
//     is loaded natively via `settingSources: ['project']`. Layering it
//     here would shadow a contract devs already understand.
//   - manage tenant overlay refresh cadence beyond a single job. The
//     gitRemote loader pulls on every resolve; that's intentional for
//     correctness today, and Phase 5 can add ETag-style caching.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { Logger } from 'pino'

import {
  loadCloudBlobOverlay,
  loadGitRemoteOverlay,
  loadLocalDirOverlay,
  loadRepoOverlay,
} from './loaders'
import { applyLayer } from './merge'
import type { TenantContext } from './tenant-context'
import type { PluginRegistry } from '../plugins/registry'

/** Inputs to {@link resolveJobIntelligence}. */
export interface ResolveJobIntelligenceArgs {
  /** Absolute path to `@coro-ai/intelligence-base/layer` for this runner. */
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
  /**
   * Absolute path to the cloned target repository, if known. Used to
   * discover `<repoCheckoutDir>/.coro/` for the repo overlay layer. May
   * be omitted (or refer to a non-existent dir) at initial resolve;
   * callers can re-resolve later via {@link resolveJobIntelligence} once
   * the agent has cloned the repo.
   */
  repoCheckoutDir?: string
  /**
   * Root under which loaders cache per-tenant artifacts (e.g. the
   * gitRemote loader's clones). Defaults to `<workingRoot>/.cache/`.
   * Phase 5 will switch the runner to pass `~/.coro/cache/`.
   */
  loaderCacheRoot?: string
  /**
   * Plugin registry consulted for the optional plugin-intelligence
   * pass. When provided, every loaded plugin's `intelligenceRoot()`
   * is applied as its own layer (between tenant and repo) so plugins
   * can ship provider-specific snippets and skills without forcing
   * the base layer to know about them.
   */
  plugins?: PluginRegistry
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
 * Materialise the intelligence overlay for a single job by stacking
 * base → tenant → repo with the merge semantics defined in `merge.ts`.
 *
 * The function is async and idempotent — calling it twice for the same
 * `jobId` re-creates the directory from scratch. Use this property to
 * "refresh" intelligence mid-job once the agent has cloned the target
 * repo and a `.coro/` overlay becomes discoverable.
 */
export async function resolveJobIntelligence(
  args: ResolveJobIntelligenceArgs,
): Promise<ResolvedIntelligence> {
  const {
    baseLayerDir,
    tenantContext,
    jobId,
    workingRoot,
    repoCheckoutDir,
    plugins,
    logger,
  } = args
  const loaderCacheRoot = args.loaderCacheRoot ?? path.join(workingRoot, '.cache', 'tenant-overlays')

  if (!jobId) throw new Error('resolveJobIntelligence: jobId is required')
  if (!baseLayerDir) throw new Error('resolveJobIntelligence: baseLayerDir is required')

  // Resolve to an absolute path so downstream consumers (SDK hooks, MCP
  // tools) never accidentally relative-resolve against a different cwd.
  const intelligenceDir = path.resolve(workingRoot, jobId, JOB_INTELLIGENCE_SUBDIR)

  // Always start from a clean slate. We do NOT preserve previous content
  // because layers are idempotent and any cached state on disk could
  // mask a config or overlay change between runs.
  await fs.rm(intelligenceDir, { recursive: true, force: true })
  await fs.mkdir(intelligenceDir, { recursive: true })

  const layers: AppliedLayer[] = []

  // Layer 1 — base. Always applied; ships with the runner.
  {
    const result = await applyLayer({
      srcRoot: baseLayerDir,
      destRoot: intelligenceDir,
      layerName: 'base',
    })
    layers.push({ name: 'base', source: baseLayerDir, fileCount: result.filesApplied })
  }

  // Layer 2 — tenant overlay (optional).
  const tenantSource = await resolveTenantOverlaySource({
    tenantContext,
    cacheRoot: loaderCacheRoot,
    logger,
  })
  if (tenantSource) {
    const layerName = `tenant:${tenantContext.tenantId}`
    const result = await applyLayer({
      srcRoot: tenantSource,
      destRoot: intelligenceDir,
      layerName,
    })
    layers.push({ name: layerName, source: tenantSource, fileCount: result.filesApplied })
  }

  // Layer 2b — plugin contributions (optional).
  //
  // Each loaded plugin can ship a `intelligence/` directory with the
  // same shape as base/tenant (`.claude/skills/<id>/`, `snippets/`,
  // optionally `agents/` overrides). We apply them after the tenant
  // overlay so a tenant can still override plugin-shipped snippets,
  // and before the repo overlay so a repo's `.coro/` always wins.
  if (plugins) {
    for (const runtime of plugins.all()) {
      const root = typeof runtime.intelligenceRoot === 'function'
        ? runtime.intelligenceRoot()
        : undefined
      if (!root) continue
      try {
        await fs.access(root)
      } catch {
        // Plugin declared an intelligence root but the directory is
        // missing — common for plugins that ship no markdown yet.
        continue
      }
      const layerName = `plugin:${runtime.manifest.id}`
      const result = await applyLayer({
        srcRoot: root,
        destRoot: intelligenceDir,
        layerName,
      })
      layers.push({ name: layerName, source: root, fileCount: result.filesApplied })
    }
  }

  // Layer 3 — repo overlay (optional, opportunistic).
  if (repoCheckoutDir) {
    const repoSource = await loadRepoOverlay({ repoCheckoutDir, logger })
    if (repoSource) {
      const result = await applyLayer({
        srcRoot: repoSource,
        destRoot: intelligenceDir,
        layerName: 'repo',
      })
      layers.push({ name: 'repo', source: repoSource, fileCount: result.filesApplied })
    }
  }

  logger.info(
    {
      jobId,
      tenantId: tenantContext.tenantId,
      tenantMode: tenantContext.mode,
      intelligenceDir,
      layerCount: layers.length,
      layers: layers.map(l => ({ name: l.name, files: l.fileCount })),
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

// ── Internal: tenant overlay source dispatcher ────────────────────────────────

async function resolveTenantOverlaySource(args: {
  tenantContext: TenantContext
  cacheRoot: string
  logger: Logger
}): Promise<string | null> {
  const { tenantContext, cacheRoot, logger } = args
  const overlay = tenantContext.overlay

  switch (overlay.kind) {
    case 'none':
      return null

    case 'localDir':
      return loadLocalDirOverlay({ path: overlay.path, logger })

    case 'gitRemote':
      return loadGitRemoteOverlay({
        url: overlay.url,
        ref: overlay.ref,
        tenantId: tenantContext.tenantId,
        cacheRoot,
        logger,
      })

    case 'cloudBlob':
      return loadCloudBlobOverlay({
        key: overlay.key,
        tenantId: tenantContext.tenantId,
        logger,
      })

    default: {
      // Exhaustiveness check — TS will flag if a new variant is added
      // to TenantOverlaySource without a case here.
      const _exhaustive: never = overlay
      logger.warn({ overlay: _exhaustive }, 'Unknown tenant overlay kind — skipping')
      return null
    }
  }
}
