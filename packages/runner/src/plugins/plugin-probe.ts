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

const REDACTED = '…'

function isRedacted(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === REDACTED
}

function mergeWithRedactionFill(
  onDisk: Record<string, unknown>,
  draft: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...onDisk }
  for (const [key, draftValue] of Object.entries(draft)) {
    const diskValue = onDisk[key]
    if (isRedacted(draftValue)) {
      if (diskValue !== undefined) out[key] = diskValue
      continue
    }
    if (
      draftValue !== null
      && typeof draftValue === 'object'
      && !Array.isArray(draftValue)
      && diskValue !== null
      && typeof diskValue === 'object'
      && !Array.isArray(diskValue)
    ) {
      out[key] = mergeWithRedactionFill(
        diskValue as Record<string, unknown>,
        draftValue as Record<string, unknown>,
      )
      continue
    }
    out[key] = draftValue
  }
  return out
}

export async function createTransientPluginRuntime(args: {
  pluginId: string
  config: Record<string, unknown>
  logger: Logger
  pluginsConfig: PluginsConfig
  settings?: Settings
  dropinPluginsRoot?: string
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
  await runtime.init(args.config, { logger: args.logger, fetch: globalThis.fetch })
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
  const runtime =
    args.existingRuntime
    ?? (await createTransientPluginRuntime({
      pluginId: args.pluginId,
      config: merged,
      logger: args.logger,
      pluginsConfig: args.pluginsConfig,
      ...(args.settings ? { settings: args.settings } : {}),
    }))

  if (!runtime) {
    return { ok: false, message: `Unknown plugin "${args.pluginId}"` }
  }

  if (typeof runtime.testConnection === 'function') {
    return runtime.testConnection(merged)
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
