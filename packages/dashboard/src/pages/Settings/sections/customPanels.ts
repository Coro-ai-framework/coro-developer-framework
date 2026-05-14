import type { ComponentType } from 'react'
import AnthropicAuthPanel from './AnthropicAuthPanel'

/**
 * Registry mapping `manifest.ui.customPanel` ids to the React
 * component that should render in place of the schema-driven
 * {@link PluginConfigCard} body. Plugins opt-in via their manifest;
 * the registry stays small and explicit so an unknown id falls
 * back to the generic schema form rather than rendering nothing.
 */
export const customPanels: Record<
  string,
  ComponentType<{ pluginId: string; onConnected?: () => void }>
> = {
  'anthropic-auth': AnthropicAuthPanel,
}
