// Public surface of the plugin system. Re-exports the contracts,
// registry, and ExternalRef primitives so importers don't need to know
// the internal file layout.
//
// `ExternalRef` / `NormalizedEvent` *types* now live in
// `@coro-ai/cloud-protocol`; only the runner-side helpers (e.g.
// `repoKeyForStorage`, `resolveJobByExternalRef`) are re-exported
// from `./refs`.

export * from './types'
export * from './refs'
export * from './registry'
export * from './webhook-bridge'
export {
  HOST_PLUGIN_API_VERSION,
  isCompatibleHostVersion,
  loadDropinPlugins,
  loadOne as loadOneDropinPlugin,
  buildDropinFactoryMap,
  defaultDropinPluginsRoot,
  type DropinManifest,
  type DropinPluginFactory,
  type LoadDropinPluginsArgs,
} from './loader'
export {
  BUILTIN_PLUGIN_IDS_BY_KIND,
  listBuiltinPluginMetadata,
  type BuiltinPluginMetadata,
} from './builtin'
