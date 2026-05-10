import { useMemo } from 'react'
import SettingsSection from '../../../components/settings/SettingsSection'
import SettingsNotice from '../../../components/settings/SettingsNotice'
import Field from '../../../components/forms/field'
import { ApiError, jsonRequest, requestJson } from '../../../lib/http'
import { useSettings, type PluginEntry } from '../SettingsContext'
import { evaluateReadiness } from '../readiness'
import PluginConfigCard from './PluginConfigCard'
import type { TestConnectionResult } from '../../../components/settings/TestConnectionButton'

interface TrackerTestResponse {
  ok: boolean
  message?: string
}

/**
 * Translate the per-plugin draft config into the legacy /test/tracker
 * payload shape so the user gets a real connectivity check for the
 * built-in trackers. Returns null for unknown plugin ids (drop-ins
 * fall through to a soft "no generic test" notice).
 */
function buildTrackerTestPayload(
  pluginId: string,
  config: Record<string, unknown>,
): Record<string, unknown> | null {
  if (pluginId === 'jira') {
    return {
      provider: 'jira',
      jira: {
        baseUrl: String(config['baseUrl'] ?? ''),
        username: String(config['username'] ?? ''),
        apiToken: String(config['apiToken'] ?? ''),
      },
    }
  }
  if (pluginId === 'linear') {
    return {
      provider: 'linear',
      linear: {
        apiKey: String(config['apiKey'] ?? ''),
        teamKey: String(config['teamKey'] ?? ''),
      },
    }
  }
  if (pluginId === 'github-issues') {
    return {
      provider: 'github',
      git: {
        provider: 'github',
        username: String(config['defaultOwner'] ?? ''),
        token: String(config['token'] ?? ''),
        workspace: String(config['defaultOwner'] ?? ''),
      },
    }
  }
  return null
}

export default function IssueTrackerSection() {
  const {
    draft,
    claudeLogin,
    claudeLoginAccount,
    pluginsCatalogue,
    pluginsCatalogueError,
    setPluginDefault,
  } = useSettings()
  const readiness = evaluateReadiness({ draft, claudeLogin, claudeLoginAccount, pluginsCatalogue }).byId['issue-tracker']

  const trackerPlugins: PluginEntry[] = useMemo(() => {
    if (!pluginsCatalogue) return []
    return pluginsCatalogue.plugins
      .filter(p => p.manifest.kind === 'tracker')
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === 'builtin' ? -1 : 1
        return a.manifest.displayName.localeCompare(b.manifest.displayName)
      })
  }, [pluginsCatalogue])

  const enabledIds = useMemo(
    () =>
      trackerPlugins
        .filter(p => {
          const e = draft.pluginInstalled[p.manifest.id]
          return e !== undefined && e.enabled !== false
        })
        .map(p => p.manifest.id),
    [trackerPlugins, draft.pluginInstalled],
  )

  async function runTrackerTest(
    pluginId: string,
    config: Record<string, unknown>,
  ): Promise<TestConnectionResult> {
    const payload = buildTrackerTestPayload(pluginId, config)
    if (!payload) {
      return {
        ok: false,
        message: 'No generic connection test available for drop-in plugins yet — save and check the plugin healthcheck.',
      }
    }
    try {
      const response = await requestJson<TrackerTestResponse>(
        '/test/tracker',
        jsonRequest(payload, { method: 'POST' }),
      )
      return {
        ok: response.ok,
        message: response.message ?? (response.ok ? 'Connected.' : 'Connection failed.'),
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message
      return { ok: false, message }
    }
  }

  return (
    <SettingsSection
      title="Issue tracker"
      description="Tracker plugins. Each plugin maps Coro work units (epics + child issues) to a backlog system. Optional — leave all disabled to run jobs without tracker round-trips."
      status={readiness.status}
      statusLabel={readiness.status === 'optional' ? 'Optional' : readiness.label}
    >
      {pluginsCatalogueError ? (
        <SettingsNotice tone="warning">
          Couldn't load the plugin catalogue from the runner: {pluginsCatalogueError}.
        </SettingsNotice>
      ) : null}

      {trackerPlugins.length === 0 ? (
        <SettingsNotice tone="neutral">
          No tracker plugins discovered. Built-ins are bundled with the runner — restart it if this looks wrong.
        </SettingsNotice>
      ) : (
        <div className="space-y-3">
          {trackerPlugins.map(plugin => (
            <PluginConfigCard
              key={plugin.manifest.id}
              plugin={plugin}
              onTest={config => runTrackerTest(plugin.manifest.id, config)}
            />
          ))}
        </div>
      )}

      {enabledIds.length > 1 ? (
        <div className="rounded-2xl border border-line bg-overlay/30 px-4 py-3.5">
          <Field
            label="Default for new jobs"
            hint="When more than one tracker plugin is enabled, jobs use this one unless they specify a different tracker at creation time."
          >
            <select
              value={draft.pluginDefaultTracker}
              onChange={e => setPluginDefault('tracker', e.target.value)}
              className="w-full rounded-xl border border-line bg-overlay px-3 py-2 text-sm text-fg"
            >
              <option value="">(let the registry choose)</option>
              {enabledIds.map(id => (
                <option key={id} value={id}>
                  {trackerPlugins.find(p => p.manifest.id === id)?.manifest.displayName ?? id}
                </option>
              ))}
            </select>
          </Field>
        </div>
      ) : null}

      <div className="text-xs text-fg-subtle">{readiness.detail}</div>
    </SettingsSection>
  )
}
