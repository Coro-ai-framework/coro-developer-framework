// ── Built-in plugin index ────────────────────────────────────────────────────
//
// Aggregates the runtimes that ship with the runner. The legacy-config
// translator (`local-config.ts → legacyConfigToPlugins`) and the
// runner bootstrap both pull from this list so adding a new built-in
// plugin is a one-line change here plus the runtime file.

import type { Logger } from 'pino'
import type { PluginsConfig } from '../../config/plugins-config'
import type { Settings } from '../../config/settings'
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
// Each entry maps a built-in plugin id to its factory. Factories accept
// `{ config, logger, settings? }` and return a not-yet-initialised
// runtime (sync or async). The registry calls `init()` on every
// runtime after construction so plugins can validate their config
// before any downstream code observes them.
//
// `settings` is forwarded for executor plugins that need ambient SCM
// env (e.g. Anthropic injects BB_*/GH_* into the agent's git env);
// SCM/tracker plugins can ignore it.

export type BuiltinPluginFactory = (args: {
  config: Record<string, unknown>
  logger: Logger
  settings?: Settings
}) => PluginRuntime | Promise<PluginRuntime>

export const BUILTIN_PLUGIN_FACTORIES: Record<string, BuiltinPluginFactory> = {
  bitbucket: createBitBucketScmPlugin,
  github: createGitHubScmPlugin,
  jira: createJiraTrackerPlugin,
  linear: createLinearTrackerPlugin,
  // GitHub doubles as a tracker (Issues). Registered under a distinct
  // id so the SCM and Tracker halves can be enabled independently —
  // a tenant might want GH Issues for tracking but BitBucket for SCM.
  'github-issues': createGitHubTrackerPlugin,
  // Executor plugins ship in-box but are dynamic-imported so the
  // runner core never carries a top-level provider import (lint-
  // enforced by `runner-no-claude-imports.test.ts`). Additional
  // executors (Foundry, Ollama, …) can still ship as drop-ins under
  // `~/.coro/plugins/<id>/` and are loaded by the same code path.
  anthropic: async ({ logger, settings }) => {
    if (!settings) {
      throw new Error("Anthropic executor requires runner settings (built-in registry must be built with `settings`)")
    }
    const mod = await import('@coro/llm-anthropic')
    return mod.createAnthropicExecutor({ settings, logger })
  },
  openai: async ({ logger }) => {
    const mod = await import('@coro/llm-openai')
    return mod.createOpenAiExecutor({ logger })
  },
}

/**
 * Static index of built-in plugin ids grouped by kind. The `coro init`
 * CLI uses this to validate `--scm` choices without instantiating
 * every plugin (which would require valid config). Keep this list in
 * sync with {@link BUILTIN_PLUGIN_FACTORIES}.
 */
export const BUILTIN_PLUGIN_IDS_BY_KIND: Readonly<Record<'scm' | 'tracker' | 'executor', readonly string[]>> = {
  scm: ['bitbucket', 'github'],
  tracker: ['jira', 'linear', 'github-issues'],
  executor: ['anthropic', 'openai'],
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
  anthropic:
    'Built in. Configure Settings > LLM provider with an Anthropic API key, an OAuth token, or the Claude Code login flow to enable it.',
  openai:
    'Built in. Configure Settings > LLM provider with an OpenAI API key to enable Responses API execution.',
}

/**
 * Describe the built-in plugins that ship with the runner, even when they are
 * not yet configured for the current tenant. Used by the dashboard so fresh
 * installs can distinguish "built in but not enabled yet" from "not present".
 *
 * Async because some built-ins (currently Anthropic) require runner
 * settings to instantiate, so we dynamic-import their static manifest
 * instead of constructing the runtime here.
 */
export async function listBuiltinPluginMetadata(logger: Logger): Promise<BuiltinPluginMetadata[]> {
  const out: BuiltinPluginMetadata[] = []
  for (const [id, factory] of Object.entries(BUILTIN_PLUGIN_FACTORIES)) {
    const activationHint =
      BUILTIN_PLUGIN_ACTIVATION_HINTS[id]
      ?? 'Built in. Configure this plugin in Settings before using it in a job.'
    if (id === 'anthropic') {
      // Static manifest pulled via dynamic import to avoid a top-level
      // `@coro/llm-anthropic` import in the runner core. The factory
      // itself can't be invoked here because the executor's
      // constructor needs `Settings`.
      const mod = await import('@coro/llm-anthropic')
      out.push({ manifest: mod.ANTHROPIC_MANIFEST, activationHint })
      continue
    }
    if (id === 'openai') {
      const mod = await import('@coro/llm-openai')
      out.push({ manifest: mod.OPENAI_MANIFEST, activationHint })
      continue
    }
    const runtime = await factory({ config: {}, logger })
    out.push({ manifest: runtime.manifest, activationHint })
  }
  return out
}

// ── Bootstrap helper ─────────────────────────────────────────────────────────

export interface BuildPluginsArgs {
  pluginsConfig: PluginsConfig
  logger: Logger
  /**
   * Resolved runner settings. Forwarded to executor plugin factories
   * (the Anthropic executor needs `settings.bitbucket` / `settings.github`
   * to inject git env into agent processes). Optional so test setups
   * that only register SCM/tracker plugins can omit it.
   */
  settings?: Settings
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
        ...(args.settings ? { settings: args.settings } : {}),
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

  // Bootstrap fallback for built-in executor plugins: if a tenant has
  // never configured an LLM provider (no `plugins.installed.<id>` slot
  // for any built-in executor), instantiate the built-ins with empty
  // config so their HTTP routes mount and the dashboard's Settings
  // panel can drive the first-run login flow. Without this, the
  // dashboard hits 404s on /config/anthropic/claude-login/* because
  // the plugin that owns those routes isn't loaded yet — a chicken-
  // and-egg trap on every fresh install or post-Phase-F upgrade where
  // the legacy top-level `anthropic` block was silently dropped.
  for (const id of BUILTIN_PLUGIN_IDS_BY_KIND.executor) {
    if (registry.byId(id)) continue
    try {
      const runtime = await instantiatePlugin({
        id,
        config: {},
        logger,
        dropinFactories,
        ...(args.settings ? { settings: args.settings } : {}),
      })
      if (!runtime) continue
      await runtime.init({}, { logger, fetch: globalThis.fetch })
      registry.register(runtime)
      logger.info(
        { pluginId: id },
        'Auto-loaded built-in executor plugin with empty config so dashboard setup routes are reachable',
      )
    } catch (err) {
      logger.warn({ err, pluginId: id }, 'Failed to auto-load built-in executor plugin')
    }
  }

  // Honour the tenant's chosen default LLM provider when one is
  // configured. The registry's resolveExecutor falls back to "sole
  // installed executor" when this isn't set, which covers the
  // single-provider common case.
  const defaultProvider = args.settings?.llm?.defaultProvider
  if (defaultProvider) {
    registry.setDefaults({ ...registry.getDefaults(), executor: defaultProvider })
  }

  return registry
}

async function instantiatePlugin(args: {
  id: string
  config: Record<string, unknown>
  logger: Logger
  dropinFactories: Record<string, DropinPluginFactory>
  settings?: Settings
}): Promise<PluginRuntime | null> {
  const builtin = BUILTIN_PLUGIN_FACTORIES[args.id]
  if (builtin) {
    return builtin({
      config: args.config,
      logger: args.logger,
      ...(args.settings ? { settings: args.settings } : {}),
    })
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
