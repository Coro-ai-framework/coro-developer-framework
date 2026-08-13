// ── Plugin catalog serialization ─────────────────────────────────────────────
//
// Builds the provider-agnostic onboarding catalog consumed by the FTUE wizard
// and Settings. Keeps JSON-schema serialisation in one place so server.ts
// and tests share the same shape.

import { z } from 'zod'
import type { Logger } from 'pino'
import type { PluginAuthMethodDescriptor, PluginManifest, PluginRuntime } from './types'
import { listBuiltinPluginMetadata, instantiatePlugin } from './builtin'
import { buildDropinFactoryMap } from './loader'
import type { PluginsConfig } from '../config/plugins-config'

export interface PluginCatalogEntry {
  id: string
  kind: string
  displayName: string
  ui?: {
    customPanel?: string
    subtitle?: string
    recommendedForOnboarding?: boolean
  }
  capabilities: Record<string, boolean>
  authMethods: ReadonlyArray<PluginAuthMethodDescriptor>
  configSchema: unknown
}

export function serializeConfigSchema(schema: PluginManifest['configSchema']): unknown {
  try {
    const toJSONSchema = (z as unknown as { toJSONSchema?: (s: unknown) => unknown }).toJSONSchema
    if (typeof toJSONSchema === 'function') {
      return toJSONSchema(schema)
    }
  } catch {
    /* ignore */
  }
  return null
}

export function manifestToCatalogEntry(m: PluginManifest): PluginCatalogEntry {
  return {
    id: m.id,
    kind: m.kind,
    displayName: m.displayName,
    ...(m.ui ? { ui: m.ui } : {}),
    capabilities: m.capabilities ?? {},
    authMethods: m.auth?.methods ?? [],
    configSchema: serializeConfigSchema(m.configSchema),
  }
}

export interface BuildPluginCatalogArgs {
  logger: Logger
  pluginsConfig: PluginsConfig
  runtimes: ReadonlyArray<PluginRuntime>
  dropinPluginsRoot?: string
}

/**
 * Catalog of every built-in and drop-in plugin manifest, including plugins
 * not yet configured — so the FTUE wizard can render provider cards on a
 * fresh install.
 */
export async function buildPluginCatalog(args: BuildPluginCatalogArgs): Promise<PluginCatalogEntry[]> {
  const { logger, pluginsConfig, runtimes } = args
  const builtinMetadata = await listBuiltinPluginMetadata(logger)
  const dropinFactories = await buildDropinFactoryMap({
    pluginsConfig,
    logger,
    ...(args.dropinPluginsRoot ? { pluginsRoot: args.dropinPluginsRoot } : {}),
  })

  const manifestById = new Map<string, PluginManifest>()
  for (const entry of builtinMetadata) {
    manifestById.set(entry.manifest.id, entry.manifest)
  }
  for (const runtime of runtimes) {
    manifestById.set(runtime.manifest.id, runtime.manifest)
  }
  for (const id of Object.keys(dropinFactories)) {
    if (manifestById.has(id)) continue
    try {
      const runtime = await instantiatePlugin({
        id,
        config: {},
        logger,
        dropinFactories,
      })
      if (runtime) manifestById.set(id, runtime.manifest)
    } catch {
      /* drop-in may require config — skip */
    }
  }

  return Array.from(manifestById.values()).map(manifestToCatalogEntry)
}
