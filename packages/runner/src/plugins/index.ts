// Public surface of the plugin system. Re-exports the contracts,
// registry, and ExternalRef primitives so importers don't need to know
// the internal file layout.

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
