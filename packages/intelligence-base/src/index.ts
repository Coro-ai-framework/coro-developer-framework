// @coro/intelligence-base
//
// Asset package: ships the company-agnostic markdown intelligence (agents,
// workflows, skills, .claude/CLAUDE.md skeleton, memory templates) that
// every Coro install starts from.
//
// Consumers (the runner, the dashboard, the CLI) call `getBaseLayerRoot()`
// to discover the absolute on-disk path of the layer. The runner can then
// stack tenant + repo overlays on top via the intelligence resolver
// (introduced in a later phase).
//
// The layer files live in `<package>/layer/` so they ship as plain assets
// alongside the compiled JS and remain editable as ordinary text files in
// dev. Nothing here is a hot path — `getBaseLayerRoot()` is called once
// per job, not per phase.

import * as path from 'node:path'

/**
 * Logical name + version of the base intelligence layer. Bumped when the
 * shape of the layer changes in a way tenants need to know about
 * (e.g. a new agent role, a renamed workflow phase).
 */
export const BASE_LAYER_NAME = '@coro/intelligence-base'
export const BASE_LAYER_VERSION = '0.1.0'

/**
 * Files & directories the runner may rely on existing in any
 * intelligence layer (base, tenant, repo). The resolver uses this list
 * to validate overlays and to drive layer diffing in the dashboard.
 */
export const LAYER_FILES = {
  claudeMd: '.claude/CLAUDE.md',
  skillsDir: '.claude/skills',
  agentsDir: 'agents',
  workflowsDir: 'workflows',
  memoryDir: 'memory',
  memoryIndex: 'memory/MEMORY.md',
} as const

export type LayerFileKey = keyof typeof LAYER_FILES

/**
 * Absolute on-disk path of the base intelligence layer.
 *
 * Resolution strategy (first hit wins):
 * 1. The compiled bundle (`dist/`) — its sibling `layer/` is the shipped
 *    layer in production installs.
 * 2. The source bundle (`src/`) — used in dev / tests when the package
 *    has not been built; falls back to `<package>/layer/`.
 *
 * We avoid `require.resolve('@coro/intelligence-base/package.json')`
 * because that flips behaviour based on hoisting under pnpm. Walking
 * up from `__dirname` is deterministic and works the same in dev,
 * test, and production.
 */
export function getBaseLayerRoot(): string {
  // dist/index.js → ../../layer
  // src/index.ts  → ../layer  (during ts-node / vitest runs)
  const fromDist = path.resolve(__dirname, '..', 'layer')
  return fromDist
}

/**
 * Convenience helper: absolute path to a known file inside the base layer.
 *
 *   pathInBaseLayer('claudeMd')  // → /…/layer/.claude/CLAUDE.md
 */
export function pathInBaseLayer(key: LayerFileKey): string {
  return path.join(getBaseLayerRoot(), LAYER_FILES[key])
}
