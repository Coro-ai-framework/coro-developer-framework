// ── Built-in plugin index ────────────────────────────────────────────────────
//
// Aggregates the runtimes that ship with the runner. The legacy-config
// translator (`local-config.ts → legacyConfigToPlugins`) and the
// runner bootstrap both pull from this list so adding a new built-in
// plugin is a one-line change here plus the runtime file.

import type { Logger } from 'pino'
import type { PluginsConfig } from '../../config/plugins-config'
import { PluginRegistry } from '../registry'
import type { PluginManifest, PluginRuntime } from '../types'
import { buildDropinFactoryMap, type DropinPluginFactory } from '../loader'
import { createBitBucketScmPlugin } from './bitbucket'
import { createGitHubScmPlugin } from './github'
import { createJiraTrackerPlugin } from './jira'
import { createLinearTrackerPlugin } from './linear'
import { createGitHubTrackerPlugin } from './github-tracker'

// ── Built-in plugin factories ────────────────────────────────────────────────
//
// Each entry maps a built-in plugin id to its factory. Factories are
// pure: they accept `{ config }` and return a not-yet-initialised
// runtime. The registry calls `init()` on every runtime after
// construction so plugins can validate their config before any
// downstream code observes them.

export type BuiltinPluginFactory = (args: {
  config: Record<string, unknown>
  logger: Logger
}) => PluginRuntime

export const BUILTIN_PLUGIN_FACTORIES: Record<string, BuiltinPluginFactory> = {
  bitbucket: createBitBucketScmPlugin,
  github: createGitHubScmPlugin,
  jira: createJiraTrackerPlugin,
  linear: createLinearTrackerPlugin,
  // GitHub doubles as a tracker (Issues). Registered under a distinct
  // id so the SCM and Tracker halves can be enabled independently —
  // a tenant might want GH Issues for tracking but BitBucket for SCM.
  'github-issues': createGitHubTrackerPlugin,
}

/**
 * Static index of built-in plugin ids grouped by kind. The `coro init`
 * CLI uses this to validate `--scm` choices without instantiating
 * every plugin (which would require valid config). Keep this list in
 * sync with {@link BUILTIN_PLUGIN_FACTORIES}.
 */
export const BUILTIN_PLUGIN_IDS_BY_KIND: Readonly<Record<'scm' | 'tracker', readonly string[]>> = {
  scm: ['bitbucket', 'github'],
  tracker: ['jira', 'linear', 'github-issues'],
}

export interface BuiltinPluginMetadata {
  manifest: PluginManifest
  activationHint: string
}

const BUILTIN_PLUGIN_ACTIVATION_HINTS: Readonly<Record<string, string>> = {
  bitbucket:
    'Built in. Configure Settings > Git with provider Bitbucket, workspace slug, username, and app password to enable it.',
  github:
    'Built in. Configure Settings > Git with provider GitHub, organization/owner, and personal access token to enable it.',
  jira:
    'Built in. Configure Settings > Tracker with provider Jira, base URL, username, and API token to enable it.',
  linear:
    'Built in. Configure Settings > Tracker with provider Linear and an API key to enable it.',
  'github-issues':
    'Built in. Configure Settings > Tracker with provider GitHub and complete the GitHub settings to enable GitHub Issues.',
}

/**
 * Describe the built-in plugins that ship with the runner, even when they are
 * not yet configured for the current tenant. Used by the dashboard so fresh
 * installs can distinguish "built in but not enabled yet" from "not present".
 */
export function listBuiltinPluginMetadata(logger: Logger): BuiltinPluginMetadata[] {
  return Object.entries(BUILTIN_PLUGIN_FACTORIES).map(([id, factory]) => ({
    manifest: factory({ config: {}, logger }).manifest,
    activationHint:
      BUILTIN_PLUGIN_ACTIVATION_HINTS[id]
      ?? 'Built in. Configure this plugin in Settings before using it in a job.',
  }))
}

// ── Bootstrap helper ─────────────────────────────────────────────────────────

export interface BuildPluginsArgs {
  pluginsConfig: PluginsConfig
  logger: Logger
  /**
   * Override `~/.coro/plugins/` for the v1.5 drop-in loader. Tests pass
   * an isolated tmpdir; production leaves this undefined so the loader
   * uses the user's home dir.
   */
  dropinPluginsRoot?: string
}

/**
 * Build a fully initialised registry from the resolved
 * `PluginsConfig`.
 *
 * Resolution order per id:
 *   1. Built-in factory (this file).
 *   2. Drop-in factory under `~/.coro/plugins/<id>/` (the v1.5 loader).
 *
 * Plugin ids that resolve from neither path are skipped with a warn —
 * a misspelled id, or a folder that hasn't been cloned yet, shouldn't
 * stop the rest of the registry from booting.
 */
export async function buildBuiltinPluginRegistry(
  args: BuildPluginsArgs,
): Promise<PluginRegistry> {
  const { pluginsConfig, logger } = args
  const registry = new PluginRegistry(pluginsConfig.defaults ?? {})

  // Load v1.5 drop-in plugins up front — same factory shape as
  // built-ins so the loop below treats them identically.
  const dropinFactoryArgs: Parameters<typeof buildDropinFactoryMap>[0] = {
    pluginsConfig,
    logger,
    ...(args.dropinPluginsRoot ? { pluginsRoot: args.dropinPluginsRoot } : {}),
  }
  const dropinFactories = await buildDropinFactoryMap(dropinFactoryArgs)

  for (const [id, slot] of Object.entries(pluginsConfig.installed ?? {})) {
    if (!slot.enabled) continue
    try {
      const runtime = await instantiatePlugin({
        id,
        config: slot.config ?? {},
        logger,
        dropinFactories,
      })
      if (!runtime) {
        logger.warn(
          { pluginId: id },
          'Plugin id is neither a built-in nor a drop-in plugin — skipping (check ~/.coro/plugins/<id>/ or the spelling)',
        )
        continue
      }
      await runtime.init(slot.config ?? {}, { logger, fetch: globalThis.fetch })
      registry.register(runtime)
    } catch (err) {
      logger.error({ err, pluginId: id }, 'Failed to initialise plugin — skipping')
    }
  }

  return registry
}

async function instantiatePlugin(args: {
  id: string
  config: Record<string, unknown>
  logger: Logger
  dropinFactories: Record<string, DropinPluginFactory>
}): Promise<PluginRuntime | null> {
  const builtin = BUILTIN_PLUGIN_FACTORIES[args.id]
  if (builtin) {
    return builtin({ config: args.config, logger: args.logger })
  }
  const dropin = args.dropinFactories[args.id]
  if (dropin) {
    return dropin.factory({ config: args.config, logger: args.logger })
  }
  return null
}

export * from './bitbucket'
export * from './github'
export * from './jira'
export * from './linear'
export * from './github-tracker'
