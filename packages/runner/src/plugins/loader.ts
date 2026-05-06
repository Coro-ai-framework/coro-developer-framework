// ── Drop-in plugin loader (v1.5) ─────────────────────────────────────────────
//
// Scans `~/.coro/plugins/<id>/` (override-able for tests) for folders that
// look like Coro plugins:
//
//   ~/.coro/plugins/
//     my-scm/
//       coro-plugin.json   ← static manifest (id, kind, version, …)
//       index.{js,cjs,mjs} ← default export = (deps) => PluginRuntime
//       intelligence/     ← optional plugin-contributed markdown
//
// What this loader is NOT:
//   - A package manager. It does not install dependencies, version-pin,
//     or download anything. The user `git clone`s or copies a folder
//     into `~/.coro/plugins/`. Bring-your-own-deps is the trust model.
//   - A sandbox. The plugin runs in the same Node process as the runner;
//     auditing the source is the user's responsibility.
//
// The loader's contract:
//   1. Read `coro-plugin.json` and validate against {@link DropinManifest}.
//   2. Reject the plugin when `hostCompatibility` doesn't satisfy the
//      runner's host-API version (see {@link HOST_PLUGIN_API_VERSION}).
//   3. Dynamically import `index.{js,cjs,mjs}` and call its default
//      export with `{ logger }` to obtain a `PluginRuntime`.
//   4. Skip (with a warning) any folder that fails any of the above —
//      one bad plugin should not poison startup.
//
// The result is a list of `{ id, factory }` entries the bootstrap can
// hand straight to the registry, sitting alongside built-in plugins.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import type { Logger } from 'pino'
import type { PluginRuntime } from './types'
import type { PluginsConfig } from '../config/plugins-config'

// ── Host plugin API version ──────────────────────────────────────────────────

/**
 * The runner's plugin-API version. Bumped (per semver) every time we
 * make a non-additive change to {@link PluginManifest} or
 * {@link PluginRuntime}. v1 ships with `1.0.0` and matches every
 * built-in plugin's `hostCompatibility: '^1.0.0'`.
 *
 * Plugin authors pin their compatibility against this constant; the
 * loader rejects plugins whose declared range doesn't include the
 * current host version, which keeps a v2-incompatible plugin out of
 * a v1.5 runner without crashing it.
 */
export const HOST_PLUGIN_API_VERSION = '1.0.0'

// ── Manifest schema ──────────────────────────────────────────────────────────

/**
 * On-disk manifest shape. We intentionally keep this independent of
 * {@link PluginManifest} (the runtime shape) — the on-disk JSON is
 * `JSON.parse()`able, which means it cannot carry a Zod schema. The
 * runtime's `configSchema` is provided by `index.{js,…}` instead.
 *
 * `id`, `kind`, `version`, and `hostCompatibility` are required. Other
 * fields are forwarded verbatim so the dashboard can render plugin
 * metadata without reading the runtime module.
 */
const dropinManifestSchema = z.object({
  id: z.string().min(1),
  kind: z.union([z.literal('scm'), z.literal('tracker'), z.string().min(1)]),
  version: z.string().min(1),
  displayName: z.string().min(1),
  hostCompatibility: z.string().min(1),
  capabilities: z.record(z.string(), z.boolean()).optional(),
  webhook: z.object({
    pathSuffix: z.string().optional(),
    algorithm: z.union([
      z.literal('hmac-sha256'),
      z.literal('hmac-sha1'),
      z.literal('none'),
    ]),
    header: z.string().min(1),
    format: z.union([
      z.literal('sha256=<hex>'),
      z.literal('sha1=<hex>'),
      z.literal('<hex>'),
      z.literal('<plain>'),
    ]),
  }).optional(),
  intelligence: z.object({
    skills: z.array(z.object({
      id: z.string().min(1),
      relativePath: z.string().min(1),
    })).optional(),
    snippets: z.array(z.object({
      id: z.string().min(1),
      relativePath: z.string().min(1),
    })).optional(),
  }).optional(),
})

export type DropinManifest = z.infer<typeof dropinManifestSchema>

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * What `loadDropinPlugins` returns for the bootstrap to combine with
 * `BUILTIN_PLUGIN_FACTORIES`. The factory signature matches
 * {@link BuiltinPluginFactory} so the registry build path is identical.
 */
export interface DropinPluginFactory {
  id: string
  manifest: DropinManifest
  /** Path to the plugin folder — used for `intelligenceRoot()`. */
  rootDir: string
  /** Async factory (dynamic import is async). */
  factory: (args: { config: Record<string, unknown>; logger: Logger }) => Promise<PluginRuntime>
}

export interface LoadDropinPluginsArgs {
  /** Override the default `~/.coro/plugins`. Used by tests. */
  pluginsRoot?: string
  /**
   * Limit which ids are considered. When omitted, every subfolder of
   * `pluginsRoot` is examined. The bootstrap passes this from the
   * resolved {@link PluginsConfig.installed} keys so a tenant can
   * install a plugin without enabling it.
   */
  onlyIds?: ReadonlyArray<string>
  logger: Logger
}

/**
 * Default plugins root: `<HOME>/.coro/plugins`. We read it lazily so
 * tests can stub `os.homedir()`.
 */
export function defaultDropinPluginsRoot(): string {
  return path.join(os.homedir(), '.coro', 'plugins')
}

/**
 * Walk the drop-in plugins root and return everything that validates.
 * Errors per-plugin are caught and logged so one broken folder cannot
 * stop the others from loading.
 */
export async function loadDropinPlugins(
  args: LoadDropinPluginsArgs,
): Promise<DropinPluginFactory[]> {
  const root = args.pluginsRoot ?? defaultDropinPluginsRoot()
  const logger = args.logger

  if (!fs.existsSync(root)) {
    return []
  }

  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true })
  } catch (err) {
    logger.warn({ err, root }, 'Drop-in plugin loader: failed to read plugins root — skipping')
    return []
  }

  const factories: DropinPluginFactory[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    if (args.onlyIds && !args.onlyIds.includes(entry.name)) continue

    const pluginDir = path.join(root, entry.name)
    try {
      const factory = await loadOne({ pluginDir, logger })
      if (factory) factories.push(factory)
    } catch (err) {
      logger.warn(
        { err, pluginDir },
        'Drop-in plugin loader: failed to load plugin — skipping',
      )
    }
  }

  return factories
}

/**
 * Load one plugin folder. Returns `null` when the folder is not a
 * Coro plugin (no `coro-plugin.json`); throws when the manifest is
 * malformed or the host compatibility check fails — the caller logs
 * and skips. Exposed for unit tests so they can exercise the
 * single-folder path without rendering an entire `~/.coro/plugins/`.
 */
export async function loadOne(args: {
  pluginDir: string
  logger: Logger
}): Promise<DropinPluginFactory | null> {
  const { pluginDir, logger } = args
  const manifestPath = path.join(pluginDir, 'coro-plugin.json')
  if (!fs.existsSync(manifestPath)) {
    logger.debug({ pluginDir }, 'Drop-in plugin loader: no coro-plugin.json — not a plugin folder, skipping')
    return null
  }

  const raw = await fs.promises.readFile(manifestPath, 'utf-8')
  const parsed: unknown = JSON.parse(raw)
  const manifest = dropinManifestSchema.parse(parsed)

  if (!isCompatibleHostVersion(manifest.hostCompatibility, HOST_PLUGIN_API_VERSION)) {
    throw new Error(
      `plugin "${manifest.id}" declares hostCompatibility="${manifest.hostCompatibility}" ` +
      `but the runner's host plugin API version is ${HOST_PLUGIN_API_VERSION}. ` +
      `Upgrade the plugin or the runner so the ranges line up.`,
    )
  }

  const entryPath = await locateEntry(pluginDir)
  if (!entryPath) {
    throw new Error(
      `plugin "${manifest.id}" has no index.js / index.cjs / index.mjs at ${pluginDir}. ` +
      `Drop-in plugins must export a default factory from one of those files.`,
    )
  }

  const factory: DropinPluginFactory = {
    id: manifest.id,
    manifest,
    rootDir: pluginDir,
    factory: async ({ config, logger: childLogger }) => {
      const mod = await import(pathToFileURL(entryPath).href) as { default?: unknown }
      const exported = mod.default ?? (mod as { default?: unknown }).default
      if (typeof exported !== 'function') {
        throw new Error(
          `plugin "${manifest.id}" did not default-export a factory function ` +
          `(got typeof=${typeof exported}). Expected ` +
          `(deps) => PluginRuntime.`,
        )
      }
      const runtime = await (exported as (deps: { config: Record<string, unknown>; logger: Logger }) => unknown)({
        config,
        logger: childLogger,
      })
      assertRuntimeShape(runtime, manifest.id)
      return runtime as PluginRuntime
    },
  }
  return factory
}

async function locateEntry(pluginDir: string): Promise<string | null> {
  for (const candidate of ['index.mjs', 'index.cjs', 'index.js']) {
    const p = path.join(pluginDir, candidate)
    if (fs.existsSync(p)) return p
  }
  return null
}

function assertRuntimeShape(value: unknown, id: string): void {
  if (!value || typeof value !== 'object') {
    throw new Error(`plugin "${id}" factory returned ${typeof value}; expected an object implementing PluginRuntime`)
  }
  const v = value as Record<string, unknown>
  if (!v['manifest'] || typeof v['init'] !== 'function' || typeof v['healthcheck'] !== 'function' || typeof v['dispose'] !== 'function') {
    throw new Error(
      `plugin "${id}" factory return shape is missing one of: manifest, init, healthcheck, dispose. ` +
      `Implement the PluginRuntime contract.`,
    )
  }
}

// ── Host-compatibility check ─────────────────────────────────────────────────
//
// We accept a tiny subset of npm semver:
//   - exact: "1.0.0"
//   - caret range: "^1.0.0"
//   - tilde range: "~1.0.0"
//   - any: "*"
//
// This is enough for v1.5 (every built-in plugin uses `^1.0.0`) and
// keeps us out of the npm `semver` dependency. Once we cross into v2+
// we'll swap this for the real package — until then, a 60-line
// implementation beats a 1.5MB transitive footprint.

export function isCompatibleHostVersion(range: string, host: string): boolean {
  const r = range.trim()
  if (r === '*' || r === '') return true

  if (r.startsWith('^')) return caretSatisfies(host, r.slice(1))
  if (r.startsWith('~')) return tildeSatisfies(host, r.slice(1))

  return strictEquals(host, r)
}

interface SemverParts {
  major: number
  minor: number
  patch: number
}

function parse(version: string): SemverParts | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  if (!m) return null
  const major = m[1]
  const minor = m[2]
  const patch = m[3]
  if (major === undefined || minor === undefined || patch === undefined) return null
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  }
}

function strictEquals(host: string, target: string): boolean {
  const a = parse(host)
  const b = parse(target)
  if (!a || !b) return false
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch
}

function caretSatisfies(host: string, target: string): boolean {
  // ^1.2.3 matches >=1.2.3 <2.0.0 (and ^0.x.y narrows to the patch level
  // — same as npm. We keep things simple here: pre-1.0 plugins ought
  // to declare exact ranges anyway).
  const a = parse(host)
  const b = parse(target)
  if (!a || !b) return false
  if (a.major !== b.major) return false
  if (b.major === 0 && a.minor !== b.minor) return false
  if (a.major < b.major) return false
  if (a.major === b.major && a.minor < b.minor) return false
  if (a.major === b.major && a.minor === b.minor && a.patch < b.patch) return false
  return true
}

function tildeSatisfies(host: string, target: string): boolean {
  // ~1.2.3 matches >=1.2.3 <1.3.0
  const a = parse(host)
  const b = parse(target)
  if (!a || !b) return false
  if (a.major !== b.major) return false
  if (a.minor !== b.minor) return false
  if (a.patch < b.patch) return false
  return true
}

// ── Bootstrap helper ─────────────────────────────────────────────────────────

/**
 * Convenience wrapper used by the runner bootstrap: load drop-in
 * plugins, filter by the resolved {@link PluginsConfig}, return a
 * factory map keyed by id (same shape as `BUILTIN_PLUGIN_FACTORIES`).
 *
 * Intentionally defensive: a tenant who lists a drop-in id in
 * `plugins.installed` but doesn't actually have the folder yet
 * shouldn't see the runner crash — they get a warning and the rest of
 * the registry still boots.
 */
export async function buildDropinFactoryMap(args: {
  pluginsConfig: PluginsConfig
  logger: Logger
  pluginsRoot?: string
}): Promise<Record<string, DropinPluginFactory>> {
  const installedIds = Object.entries(args.pluginsConfig.installed ?? {})
    .filter(([, slot]) => slot.enabled)
    .map(([id]) => id)
  const factoryArgs: LoadDropinPluginsArgs = {
    onlyIds: installedIds,
    logger: args.logger,
    ...(args.pluginsRoot ? { pluginsRoot: args.pluginsRoot } : {}),
  }
  const factories = await loadDropinPlugins(factoryArgs)
  const map: Record<string, DropinPluginFactory> = {}
  for (const f of factories) {
    map[f.id] = f
  }
  return map
}
