import type { SettingStatus } from '../../components/settings/StatusBadge'
import type {
  SettingsDraft,
  SettingsSectionId,
  PluginsCatalogue,
  PluginEntry,
} from './SettingsContext'

interface ReadinessInput {
  draft: SettingsDraft
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
const KNOWN_EXECUTOR_FALLBACK = ['anthropic']

export function evaluateReadiness({ draft, pluginsCatalogue }: ReadinessInput): ReadinessSummary {
  // LLM provider ──
  // Readiness = the configured default executor plugin exists in the
  // catalogue, has an entry under `pluginInstalled`, and every
  // required-by-schema field on that entry is filled. Everything else
  // ("is Claude logged in?", "is the API key non-empty?") is the
  // plugin's own concern via its config schema or custom panel.
  const executorPlugins = pluginsCatalogue?.plugins.filter(p => p.manifest.kind === 'executor') ?? []
  const isExecutorId = (id: string): boolean => {
    if (!pluginsCatalogue) return KNOWN_EXECUTOR_FALLBACK.includes(id)
    return executorPlugins.some(p => p.manifest.id === id)
  }
  // When the user hasn't explicitly picked a default provider, mirror
  // the runner-side synthesis logic (see runner/src/runner/server.ts):
  // prefer an executor that is both *enabled* and *configured* over
  // one that simply happens to be first alphabetically. Without this,
  // having two executors registered (e.g. built-in anthropic + openai)
  // with only one of them keyed makes the banner permanently warn,
  // because the alphabetically-first plugin reports "needs setup"
  // even though the runner will happily route to the configured one
  // at job-dispatch time.
  const pickAutoExecutor = (): string => {
    const enabledConfigured = executorPlugins.filter(p => {
      const entry = draft.pluginInstalled[p.manifest.id]
      if (entry?.enabled === false) return false
      return pluginIsConfigured(draft, p, p.manifest.id)
    })
    if (enabledConfigured.length === 1) return enabledConfigured[0].manifest.id
    if (enabledConfigured.length > 1) return enabledConfigured[0].manifest.id
    // No configured candidate — fall back to first enabled, then to
    // the alphabetical first so the rest of the readiness pipeline
    // still produces a meaningful "needs configuration" message.
    const firstEnabled = executorPlugins.find(p => {
      const entry = draft.pluginInstalled[p.manifest.id]
      return entry?.enabled !== false
    })
    return firstEnabled?.manifest.id ?? executorPlugins[0]?.manifest.id ?? ''
  }
  const defaultExecutorId = draft.llmDefaultProvider || pickAutoExecutor()
  const defaultExecutor = executorPlugins.find(p => p.manifest.id === defaultExecutorId)
  const llmReady =
    !!defaultExecutorId
    && isExecutorId(defaultExecutorId)
    && pluginIsConfigured(draft, defaultExecutor, defaultExecutorId)
  const llmDetail = !defaultExecutorId
    ? 'No LLM provider selected'
    : llmReady
      ? `${defaultExecutor?.manifest.displayName ?? defaultExecutorId} configured`
      : `${defaultExecutor?.manifest.displayName ?? defaultExecutorId} needs configuration`

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
    general: {
      status: 'optional',
      detail: 'Coach mode and Coro plan mode preferences',
    },
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
    guardrails: {
      status: 'optional',
      detail: draft.guardrailsEnabled
        ? `${draft.guardrailRules.filter(r => r.enabled).length} rule(s) active`
        : 'Disabled',
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
