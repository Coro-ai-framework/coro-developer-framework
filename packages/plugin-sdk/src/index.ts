// ── @coro-ai/plugin-sdk public surface ──────────────────────────────────────────
//
// Single entry point for plugin authors. Re-exports the type
// surface, helpers, and base classes so consumers do
// `import { ScmPluginBase, mcpStdioDescriptor, … } from '@coro-ai/plugin-sdk'`.

export * from './types'
export * from './helpers'
export * from './base'
export * from './executor-helpers'
export * from './mcp'
export * from './rate-limit'
export * from './guardrails'
export * from './chat-mcp'
export * from './oauth-helpers'

/**
 * The plugin-API host version this SDK release was built against.
 * Drop-in plugins compare their `manifest.hostCompatibility` against
 * the runner's `HOST_PLUGIN_API_VERSION` (kept in sync with this
 * value) to decide whether to load. Bump on breaking surface changes.
 */
export const SDK_PLUGIN_API_VERSION = '1.1.0' as const
