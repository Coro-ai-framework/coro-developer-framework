// ── Transient plugin probe helpers ───────────────────────────────────────────
//
// Used by generic `/test/plugin/:id` and detect/apply endpoints to instantiate
// a plugin without registering it in the job registry.

import type { Logger } from 'pino'
import type { PluginRuntime, PluginTestResult } from './types'
import { instantiatePlugin } from './builtin'
import { buildDropinFactoryMap } from './loader'
import type { PluginsConfig } from '../config/plugins-config'
import type { Settings } from '../config/settings'
import { isRedacted, mergeWithRedactionFill } from './redaction'

export async function createTransientPluginRuntime(args: {
  pluginId: string
  config: Record<string, unknown>
  logger: Logger
  pluginsConfig: PluginsConfig
  settings?: Settings
  dropinPluginsRoot?: string
  /**
   * Skip the hard failure when `init` rejects the config. Credential
   * detection runs before a plugin has any config, and most plugins parse a
   * strict schema in `init` — without this the detect endpoint 500s on every
   * fresh install. Detection needs only the instance, not initialised state.
   */
  tolerateInitFailure?: boolean
  /** Observe a tolerated `init` failure without it becoming a throw. */
  onInitError?: (err: unknown) => void
}): Promise<PluginRuntime | null> {
  const dropinFactories = await buildDropinFactoryMap({
    pluginsConfig: args.pluginsConfig,
    logger: args.logger,
    ...(args.dropinPluginsRoot ? { pluginsRoot: args.dropinPluginsRoot } : {}),
  })
  const runtime = await instantiatePlugin({
    id: args.pluginId,
    config: args.config,
    logger: args.logger,
    dropinFactories,
    ...(args.settings ? { settings: args.settings } : {}),
  })
  if (!runtime) return null
  try {
    await runtime.init(args.config, { logger: args.logger, fetch: globalThis.fetch })
  } catch (err) {
    if (!args.tolerateInitFailure) throw err
    args.onInitError?.(err)
    args.logger.debug(
      { err, pluginId: args.pluginId },
      'Plugin init rejected the config — continuing with an uninitialised instance for setup-only use',
    )
  }
  return runtime
}

export async function probePluginConnection(args: {
  pluginId: string
  draftConfig: Record<string, unknown>
  onDiskConfig: Record<string, unknown>
  logger: Logger
  pluginsConfig: PluginsConfig
  settings?: Settings
  existingRuntime?: PluginRuntime | null
}): Promise<PluginTestResult> {
  const merged = mergeWithRedactionFill(args.onDiskConfig, args.draftConfig)
  // An incomplete draft is the normal case while a user is filling the form,
  // so a rejected `init` must produce a test result, not a 500. Plugins with
  // a `testConnection` validate the config themselves and can say which field
  // is wrong; plugins without one get a generic message below.
  let initError: unknown
  const runtime =
    args.existingRuntime
    ?? (await createTransientPluginRuntime({
      pluginId: args.pluginId,
      config: merged,
      logger: args.logger,
      pluginsConfig: args.pluginsConfig,
      ...(args.settings ? { settings: args.settings } : {}),
      tolerateInitFailure: true,
      onInitError: err => { initError = err },
    }))

  if (!runtime) {
    return { ok: false, message: `Unknown plugin "${args.pluginId}"` }
  }

  if (typeof runtime.testConnection === 'function') {
    return runtime.testConnection(merged)
  }

  if (initError) {
    return {
      ok: false,
      message: `${runtime.manifest.displayName} rejected this configuration.`,
      hint: initError instanceof Error ? initError.message : String(initError),
    }
  }

  const health = await runtime.healthcheck()
  return {
    ok: health.ok,
    message: health.ok
      ? `${runtime.manifest.displayName} is configured.`
      : (health.reason ?? `${runtime.manifest.displayName} is not configured.`),
  }
}

export { mergeWithRedactionFill, isRedacted }
