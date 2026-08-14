import { useMemo } from 'react'
import SettingsSection from '../../../components/settings/SettingsSection'
import SettingsNotice from '../../../components/settings/SettingsNotice'
import Field from '../../../components/forms/field'
import { useSettings, type PluginEntry } from '../SettingsContext'
import { evaluateReadiness } from '../readiness'
import PluginConfigCard from './PluginConfigCard'
import { testPluginConnection } from '../../../lib/plugin-test'

export default function SourceControlSection() {
  const {
    draft,
    pluginsCatalogue,
    pluginsCatalogueError,
    setPluginDefault,
  } = useSettings()
  const readiness = evaluateReadiness({ draft, pluginsCatalogue }).byId['source-control']

  const scmPlugins: PluginEntry[] = useMemo(() => {
    if (!pluginsCatalogue) return []
    return pluginsCatalogue.plugins
      .filter(p => p.manifest.kind === 'scm')
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === 'builtin' ? -1 : 1
        return a.manifest.displayName.localeCompare(b.manifest.displayName)
      })
  }, [pluginsCatalogue])

  const enabledIds = useMemo(
    () =>
      scmPlugins
        .filter(p => {
          const e = draft.pluginInstalled[p.manifest.id]
          return e !== undefined && e.enabled !== false
        })
        .map(p => p.manifest.id),
    [scmPlugins, draft.pluginInstalled],
  )

  return (
    <SettingsSection
      title="Source control"
      description="Git provider plugins. Each plugin handles clone, branch, push, PR, and review for one host. Multiple plugins can be configured side-by-side; the default below decides which one new jobs use unless overridden."
      required
      status={readiness.status}
      statusLabel={readiness.label}
    >
      {pluginsCatalogueError ? (
        <SettingsNotice tone="warning">
          Couldn't load the plugin catalogue from the runner: {pluginsCatalogueError}.
        </SettingsNotice>
      ) : null}

      {scmPlugins.length === 0 ? (
        <SettingsNotice tone="neutral">
          No source-control plugins discovered. Built-ins are bundled with the runner — restart it if this looks wrong.
        </SettingsNotice>
      ) : (
        <div className="space-y-3">
          {scmPlugins.map(plugin => (
            <PluginConfigCard
              key={plugin.manifest.id}
              plugin={plugin}
              onTest={config => testPluginConnection(plugin.manifest.id, config)}
            />
          ))}
        </div>
      )}

      {enabledIds.length > 1 ? (
        <div className="rounded-2xl border border-line bg-overlay/30 px-4 py-3.5">
          <Field
            label="Default for new jobs"
            hint="When more than one source-control plugin is enabled, jobs use this one unless they specify a different SCM at creation time."
          >
            <select
              value={draft.pluginDefaultScm}
              onChange={e => setPluginDefault('scm', e.target.value)}
              className="w-full rounded-xl border border-line bg-overlay px-3 py-2 text-sm text-fg"
            >
              <option value="">(let the registry choose)</option>
              {enabledIds.map(id => (
                <option key={id} value={id}>
                  {scmPlugins.find(p => p.manifest.id === id)?.manifest.displayName ?? id}
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
