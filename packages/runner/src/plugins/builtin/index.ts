// ── Built-in plugin index ────────────────────────────────────────────────────
//
// Aggregates the runtimes that ship with the runner. The legacy-config
// translator (`local-config.ts → legacyConfigToPlugins`) and the
// runner bootstrap both pull from this list so adding a new built-in
// plugin is a one-line change here plus the runtime file.

import type { Logger } from 'pino'
import type { PluginsConfig } from '../../config/plugins-config'
import { PluginRegistry } from '../registry'
import type { PluginRuntime } from '../types'
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

// ── Bootstrap helper ─────────────────────────────────────────────────────────

export interface BuildPluginsArgs {
  pluginsConfig: PluginsConfig
  logger: Logger
}

/**
 * Build a fully initialised registry from the resolved
 * `PluginsConfig`. Plugin ids that aren't in
 * {@link BUILTIN_PLUGIN_FACTORIES} are silently ignored at v1 — the
 * v1.5 drop-in loader (P8) is what wires those in. Logs a warning so
 * misspelled ids don't fail in mysterious ways.
 */
export async function buildBuiltinPluginRegistry(
  args: BuildPluginsArgs,
): Promise<PluginRegistry> {
  const { pluginsConfig, logger } = args
  const registry = new PluginRegistry(pluginsConfig.defaults ?? {})

  for (const [id, slot] of Object.entries(pluginsConfig.installed ?? {})) {
    if (!slot.enabled) continue
    const factory = BUILTIN_PLUGIN_FACTORIES[id]
    if (!factory) {
      logger.warn(
        { pluginId: id },
        'Plugin id is not a built-in and the v1.5 drop-in loader is not yet active — skipping',
      )
      continue
    }
    try {
      const runtime = factory({ config: slot.config ?? {}, logger })
      await runtime.init(slot.config ?? {}, { logger, fetch: globalThis.fetch })
      registry.register(runtime)
    } catch (err) {
      logger.error({ err, pluginId: id }, 'Failed to initialise plugin — skipping')
    }
  }

  return registry
}

export * from './bitbucket'
export * from './github'
export * from './jira'
export * from './linear'
export * from './github-tracker'
