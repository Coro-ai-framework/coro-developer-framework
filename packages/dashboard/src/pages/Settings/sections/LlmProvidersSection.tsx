import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import SettingsSection from '../../../components/settings/SettingsSection'
import SettingsNotice from '../../../components/settings/SettingsNotice'
import Field from '../../../components/forms/field'
import { Input } from '../../../components/ui/input'
import { Button } from '../../../components/ui/button'
import { ApiError, requestJson } from '../../../lib/http'
import {
  useSettings,
  type LlmAliasConfig,
  type PluginEntry,
} from '../SettingsContext'
import { evaluateReadiness } from '../readiness'
import PluginConfigCard from './PluginConfigCard'

interface ModelDescriptor {
  id: string
  displayName: string
}

interface ModelsResponse {
  models?: ModelDescriptor[]
}

interface LlmProvidersSectionProps {
  /** When true, render without the SettingsSection card (used by the wizard). */
  embedded?: boolean
  /** Forwarded to provider custom panels (e.g. Claude login completion). */
  onConnected?: () => void
}

/**
 * Lists every executor plugin (LLM provider) discovered in the
 * runner's catalogue, plus the multi-provider routing surface
 * (`defaultProvider` + per-alias `{provider, model}` pairs).
 *
 * Provider-specific configuration (Claude OAuth, an Anthropic API
 * key, an OpenAI key + base URL, …) is rendered by
 * {@link PluginConfigCard}. Plugins that need a richer flow opt
 * into a custom panel via `manifest.ui.customPanel`.
 */
export default function LlmProvidersSection({ embedded = false, onConnected }: LlmProvidersSectionProps) {
  const {
    draft,
    setDraft,
    pluginsCatalogue,
    pluginsCatalogueError,
  } = useSettings()
  const readiness = evaluateReadiness({ draft, pluginsCatalogue }).byId['llm-provider']

  const executorPlugins: PluginEntry[] = useMemo(() => {
    if (!pluginsCatalogue) return []
    return pluginsCatalogue.plugins
      .filter(p => p.manifest.kind === 'executor')
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === 'builtin' ? -1 : 1
        return a.manifest.displayName.localeCompare(b.manifest.displayName)
      })
  }, [pluginsCatalogue])

  const enabledIds = useMemo(
    () =>
      executorPlugins
        .filter(p => {
          const e = draft.pluginInstalled[p.manifest.id]
          // Executors default to enabled when the entry exists; treat
          // an absent entry as enabled too (matches built-in defaults).
          return e === undefined || e.enabled !== false
        })
        .map(p => p.manifest.id),
    [executorPlugins, draft.pluginInstalled],
  )

  // Default provider must be one of the enabled executors. If the user
  // hasn't picked one yet, show a placeholder; the runner falls back to
  // 'anthropic' on save when this is empty.
  const defaultProviderValue = draft.llmDefaultProvider

  const setDefaultProvider = (next: string) => {
    setDraft('llmDefaultProvider', next)
  }

  // ── Aliases editor ──────────────────────────────────────────────────────
  // Aliases are flat workflow shorthands ('planning', 'coding', …) that
  // map to a `{provider, model, reasoningEffort?}` triple. We render a
  // simple table; models are fetched lazily per-provider via
  // `/plugins/:id/models` and cached in component state.

  const aliasEntries = useMemo(
    () => Object.entries(draft.llmAliases),
    [draft.llmAliases],
  )

  const updateAliases = (next: Record<string, LlmAliasConfig>) => {
    setDraft('llmAliases', next)
  }

  const renameAlias = (oldName: string, newName: string) => {
    if (!newName || newName === oldName) return
    if (draft.llmAliases[newName]) return // refuse to clobber
    const { [oldName]: row, ...rest } = draft.llmAliases
    updateAliases({ ...rest, [newName]: row })
  }

  const updateAliasField = (
    name: string,
    patch: Partial<LlmAliasConfig>,
  ) => {
    const existing = draft.llmAliases[name] ?? { provider: '', model: '' }
    updateAliases({
      ...draft.llmAliases,
      [name]: { ...existing, ...patch },
    })
  }

  const removeAlias = (name: string) => {
    const { [name]: _drop, ...rest } = draft.llmAliases
    updateAliases(rest)
  }

  const addAlias = () => {
    // Pick a unique placeholder name so the user can rename it.
    let n = 1
    let candidate = 'new-alias'
    while (draft.llmAliases[candidate]) {
      n += 1
      candidate = `new-alias-${n}`
    }
    updateAliases({
      ...draft.llmAliases,
      [candidate]: {
        provider: defaultProviderValue || enabledIds[0] || '',
        model: '',
      },
    })
  }

  // Cached model lists per provider. `null` while loading; `[]` on
  // error or empty so the select still renders (free-form fallback).
  const [modelsByProvider, setModelsByProvider] = useState<
    Record<string, ModelDescriptor[] | null | undefined>
  >({})

  const loadModels = useCallback(async (providerId: string) => {
    if (!providerId) return
    if (modelsByProvider[providerId] !== undefined) return
    setModelsByProvider(prev => ({ ...prev, [providerId]: null }))
    try {
      const data = await requestJson<ModelsResponse>(`/plugins/${encodeURIComponent(providerId)}/models`)
      setModelsByProvider(prev => ({ ...prev, [providerId]: data.models ?? [] }))
    } catch (err) {
      // 404/400 from the runner means the provider doesn't expose a
      // model list yet — surface a free-form Input rather than blocking.
      if (!(err instanceof ApiError)) throw err
      setModelsByProvider(prev => ({ ...prev, [providerId]: [] }))
    }
  }, [modelsByProvider])

  // Eagerly hydrate model lists for every provider already used in the
  // alias table so the selects render with options on first paint.
  useEffect(() => {
    const seen = new Set<string>()
    for (const [, row] of aliasEntries) {
      if (row.provider && !seen.has(row.provider)) {
        seen.add(row.provider)
        void loadModels(row.provider)
      }
    }
    if (defaultProviderValue) void loadModels(defaultProviderValue)
  }, [aliasEntries, defaultProviderValue, loadModels])

  const body = (
    <div className="space-y-6">
      {pluginsCatalogueError ? (
        <SettingsNotice tone="warning">
          Couldn't load the plugin catalogue from the runner: {pluginsCatalogueError}.
        </SettingsNotice>
      ) : null}

      {executorPlugins.length === 0 ? (
        <SettingsNotice tone="neutral">
          No LLM-provider plugins discovered. Built-ins are bundled with the runner — restart it if this looks wrong.
        </SettingsNotice>
      ) : (
        <div className="space-y-3">
          {executorPlugins.map(plugin => (
            <PluginConfigCard
              key={plugin.manifest.id}
              plugin={plugin}
              onConnected={onConnected}
            />
          ))}
        </div>
      )}

      <div className="rounded-2xl border border-line bg-overlay/30 px-4 py-3.5">
        <Field
          label="Default provider"
          hint="Used when an alias or workflow phase does not pin a provider explicitly."
        >
          <select
            value={defaultProviderValue}
            onChange={e => setDefaultProvider(e.target.value)}
            className="w-full rounded-xl border border-line bg-overlay px-3 py-2 text-sm text-fg"
          >
            <option value="">(let the runner choose — defaults to anthropic)</option>
            {enabledIds.map(id => (
              <option key={id} value={id}>
                {executorPlugins.find(p => p.manifest.id === id)?.manifest.displayName ?? id}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="rounded-2xl border border-line bg-overlay/30 px-4 py-3.5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-fg">Aliases</div>
            <div className="text-[12px] text-fg-muted">
              Workflow shorthands like <span className="font-mono">planning</span>, <span className="font-mono">coding</span>, or <span className="font-mono">evaluation</span> map to a concrete <span className="font-mono">provider/model</span> pair.
            </div>
          </div>
          <Button type="button" size="sm" variant="secondary" onClick={addAlias} disabled={enabledIds.length === 0}>
            <Plus />
            Add alias
          </Button>
        </div>

        {aliasEntries.length === 0 ? (
          <SettingsNotice tone="neutral">
            No aliases configured. The runner seeds defaults (planning/coding/evaluation) on first save if you leave this empty.
          </SettingsNotice>
        ) : (
          <div className="space-y-2">
            {aliasEntries.map(([name, row]) => {
              const models = modelsByProvider[row.provider]
              return (
                <div
                  key={name}
                  className="grid gap-2 rounded-xl border border-line bg-canvas/40 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-end"
                >
                  <Field label="Alias">
                    <Input
                      value={name}
                      onChange={e => renameAlias(name, e.target.value.trim())}
                      placeholder="coding"
                    />
                  </Field>
                  <Field label="Provider">
                    <select
                      value={row.provider}
                      onChange={e => updateAliasField(name, { provider: e.target.value, model: '' })}
                      className="w-full rounded-xl border border-line bg-overlay px-3 py-2 text-sm text-fg"
                    >
                      <option value="">(select)</option>
                      {enabledIds.map(id => (
                        <option key={id} value={id}>
                          {executorPlugins.find(p => p.manifest.id === id)?.manifest.displayName ?? id}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Model">
                    {models && models.length > 0 ? (
                      <select
                        value={row.model}
                        onChange={e => updateAliasField(name, { model: e.target.value })}
                        className="w-full rounded-xl border border-line bg-overlay px-3 py-2 text-sm text-fg"
                      >
                        <option value="">(select)</option>
                        {models.map(m => (
                          <option key={m.id} value={m.id}>
                            {m.displayName}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input
                        value={row.model}
                        onChange={e => updateAliasField(name, { model: e.target.value })}
                        placeholder={models === null ? 'Loading…' : 'claude-sonnet-4-5'}
                      />
                    )}
                  </Field>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeAlias(name)}
                    aria-label={`Remove ${name}`}
                  >
                    <Trash2 />
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="text-xs text-fg-subtle">{readiness.detail}</div>
    </div>
  )

  if (embedded) {
    return body
  }

  return (
    <SettingsSection
      title="LLM providers"
      description="Configure one or more model providers and route workflow aliases to specific provider/model pairs."
      required
      status={readiness.status}
      statusLabel={readiness.label}
    >
      {body}
    </SettingsSection>
  )
}
