import type { SettingStatus } from '../../components/settings/StatusBadge'
import type {
  SettingsDraft,
  SettingsSectionId,
  ClaudeLoginState,
  ClaudeAccountInfo,
  PluginsCatalogue,
  PluginEntry,
} from './SettingsContext'

interface ReadinessInput {
  draft: SettingsDraft
  claudeLogin: ClaudeLoginState
  claudeLoginAccount: ClaudeAccountInfo | null
  /** Optional — if absent (catalogue still loading) we fall back to a
   * built-in plugin-id allowlist heuristic so the wizard can still render. */
  pluginsCatalogue?: PluginsCatalogue | null
}

export interface ReadinessSummary {
  /** Per-section status; what the sidebar dots and section header pills show. */
  byId: Record<SettingsSectionId, { status: SettingStatus; label?: string; detail?: string }>
  /** Required-to-run-jobs gate. */
  ready: boolean
  /** Section ids that are required and not yet satisfied. */
  missingRequired: SettingsSectionId[]
}

interface JsonSchemaObject {
  required?: string[]
  properties?: Record<string, unknown>
}

function isJsonSchemaObject(schema: unknown): schema is JsonSchemaObject {
  return typeof schema === 'object' && schema !== null && !Array.isArray(schema)
}

/** A plugin entry is "configured" when every required-by-schema field
 * is non-empty in the draft. Falls back to "any value" when no schema. */
function pluginIsConfigured(
  draft: SettingsDraft,
  plugin: PluginEntry | undefined,
  pluginId: string,
): boolean {
  const entry = draft.pluginInstalled[pluginId]
  if (!entry) return false
  if (entry.enabled === false) return false
  const schema = plugin?.manifest.configSchema
  if (isJsonSchemaObject(schema) && Array.isArray(schema.required)) {
    return schema.required.every(field => {
      const v = entry.config[field]
      return typeof v === 'string' ? v.length > 0 : v != null
    })
  }
  return Object.keys(entry.config).length > 0
}

const KNOWN_SCM_FALLBACK = ['github', 'bitbucket', 'gitlab']
const KNOWN_TRACKER_FALLBACK = ['jira', 'linear', 'github-issues']

export function evaluateReadiness({ draft, claudeLogin, claudeLoginAccount, pluginsCatalogue }: ReadinessInput): ReadinessSummary {
  // LLM provider ──
  const account = claudeLogin.account ?? claudeLoginAccount
  const claudeReady = claudeLogin.status === 'connected' || !!account
  const llmReady =
    (draft.anthropicMethod === 'claudeLogin' && claudeReady) ||
    (draft.anthropicMethod === 'apiKey' && draft.apiKey.length > 0) ||
    (draft.anthropicMethod === 'oauth' && draft.oauthToken.length > 0)
  const llmDetail =
    draft.anthropicMethod === 'claudeLogin'
      ? claudeReady
        ? 'Claude login connected'
        : 'Claude login not connected'
      : draft.anthropicMethod === 'apiKey'
        ? draft.apiKey
          ? 'API key configured'
          : 'API key missing'
        : draft.oauthToken
          ? 'Legacy token configured'
          : 'Legacy token missing'

  // Plugin readiness — required fields come from each plugin's own
  // JSON Schema (catalogue), so adding a new plugin doesn't require
  // editing this file.
  const scmPlugins = pluginsCatalogue?.plugins.filter(p => p.manifest.kind === 'scm') ?? []
  const trackerPlugins = pluginsCatalogue?.plugins.filter(p => p.manifest.kind === 'tracker') ?? []

  const isScmId = (id: string): boolean => {
    if (!pluginsCatalogue) return KNOWN_SCM_FALLBACK.includes(id)
    return scmPlugins.some(p => p.manifest.id === id)
  }
  const isTrackerId = (id: string): boolean => {
    if (!pluginsCatalogue) return KNOWN_TRACKER_FALLBACK.includes(id)
    return trackerPlugins.some(p => p.manifest.id === id)
  }

  const configuredScm = Object.entries(draft.pluginInstalled)
    .filter(([id, entry]) => {
      if (entry.enabled === false) return false
      if (!isScmId(id)) return false
      const plugin = scmPlugins.find(p => p.manifest.id === id)
      return pluginIsConfigured(draft, plugin, id)
    })
    .map(([id]) => id)
  const gitConfigured = configuredScm.length > 0
  const gitDetail = gitConfigured
    ? configuredScm.length === 1
      ? `${configuredScm[0]} configured`
      : `${configuredScm.length} SCM plugins configured (default: ${draft.pluginDefaultScm || configuredScm[0]})`
    : 'No source-control plugin enabled'

  const configuredTrackers = Object.entries(draft.pluginInstalled)
    .filter(([id, entry]) => {
      if (entry.enabled === false) return false
      if (!isTrackerId(id)) return false
      const plugin = trackerPlugins.find(p => p.manifest.id === id)
      return pluginIsConfigured(draft, plugin, id)
    })
    .map(([id]) => id)

  let trackerStatus: SettingStatus = 'optional'
  let trackerDetail = 'No tracker plugin enabled'
  if (configuredTrackers.length > 0) {
    trackerStatus = 'ok'
    trackerDetail =
      configuredTrackers.length === 1
        ? `${configuredTrackers[0]} configured`
        : `${configuredTrackers.length} tracker plugins configured (default: ${draft.pluginDefaultTracker || configuredTrackers[0]})`
  } else {
    const partiallyConfigured = Object.entries(draft.pluginInstalled).some(([id, entry]) => {
      if (entry.enabled === false) return false
      if (!isTrackerId(id)) return false
      const plugin = trackerPlugins.find(p => p.manifest.id === id)
      return !pluginIsConfigured(draft, plugin, id)
    })
    if (partiallyConfigured) {
      trackerStatus = 'warn'
      trackerDetail = 'Tracker plugin enabled but required fields are missing'
    }
  }

  // MCP ──
  const mcpDetail = (() => {
    try {
      const parsed = JSON.parse(draft.mcpServersText) as Record<string, unknown>
      const count = parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 0
      return count === 0
        ? 'No BYO servers configured'
        : `${count} server${count === 1 ? '' : 's'} configured`
    } catch {
      return 'Invalid JSON'
    }
  })()

  const byId: ReadinessSummary['byId'] = {
    'llm-provider': {
      status: llmReady ? 'ok' : 'warn',
      label: llmReady ? 'Connected' : 'Needs setup',
      detail: llmDetail,
    },
    'source-control': {
      status: gitConfigured ? 'ok' : 'warn',
      label: gitConfigured ? 'Connected' : 'Needs setup',
      detail: gitDetail,
    },
    'issue-tracker': {
      status: trackerStatus,
      detail: trackerDetail,
    },
    plugins: {
      status: 'optional',
      detail: 'Drop-in plugin install + uninstall',
    },
    mcp: {
      status: 'optional',
      detail: mcpDetail,
    },
    paths: {
      status: 'optional',
      detail: 'Using resolved defaults unless overridden',
    },
  }

  const missingRequired: SettingsSectionId[] = []
  if (!llmReady) missingRequired.push('llm-provider')
  if (!gitConfigured) missingRequired.push('source-control')

  return {
    byId,
    ready: missingRequired.length === 0,
    missingRequired,
  }
}
