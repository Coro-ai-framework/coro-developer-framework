import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
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

/** A single workflow-phase reference for a given alias name. */
interface AliasUsage {
  workflowId: string
  workflowName: string
  phaseName: string
}

interface DiscoveredWorkflowsResponse {
  workflows: Array<{
    id: string
    name: string
    phases?: Array<{ name: string; model?: string }>
  }>
}

/**
 * Walks every discovered workflow (`GET /workflows`) and indexes which
 * alias name each phase references via its `model:` field. Two outputs:
 *
 *   - `usagesByAlias` — `aliasName → [{workflow, phase}, …]`. Used to
 *     render the subtle "Used in:" footer under each row, so the user
 *     can see at a glance whether renaming will break a workflow.
 *   - `referencedNames` — every distinct `model:` string discovered.
 *     Surfaced as datalist options so adding a new alias is mostly
 *     point-and-click on the names workflows actually ask for.
 *
 * Falls back silently to empty data if the endpoint is unavailable —
 * the editor stays fully functional, it just loses the suggestions.
 */
function useAliasUsages(): {
  usagesByAlias: Map<string, AliasUsage[]>
  referencedNames: string[]
} {
  const [usagesByAlias, setUsages] = useState<Map<string, AliasUsage[]>>(new Map())
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await requestJson<DiscoveredWorkflowsResponse>('/workflows')
        if (cancelled) return
        const map = new Map<string, AliasUsage[]>()
        for (const wf of data.workflows ?? []) {
          for (const phase of wf.phases ?? []) {
            const m = (phase.model ?? '').trim()
            if (!m) continue
            const list = map.get(m) ?? []
            list.push({ workflowId: wf.id, workflowName: wf.name, phaseName: phase.name })
            map.set(m, list)
          }
        }
        setUsages(map)
      } catch {
        // Non-fatal — suggestions disappear, editor still works.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  const referencedNames = useMemo(
    () => Array.from(usagesByAlias.keys()).sort(),
    [usagesByAlias],
  )
  return { usagesByAlias, referencedNames }
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
    // Preserve insertion order so the row doesn't visually jump on
    // rename — the editor's React keys are alias names, and shifting
    // them around is jarring once you have more than a couple rows.
    const next: Record<string, LlmAliasConfig> = {}
    for (const [k, v] of Object.entries(draft.llmAliases)) {
      next[k === oldName ? newName : k] = v
    }
    updateAliases(next)
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

  // Workflow → alias index, drives the alias-name datalist + per-row
  // "Used in" footer.
  const { usagesByAlias, referencedNames } = useAliasUsages()

  // Names that workflows reference but the user hasn't yet defined as
  // an alias — these are the highest-value suggestions when adding a
  // new alias because they're literally what the workflows expect.
  const undefinedReferenced = useMemo(
    () => referencedNames.filter(n => !(n in draft.llmAliases)),
    [referencedNames, draft.llmAliases],
  )

  // Shared datalist id so every alias-name input pulls from the same
  // suggestion pool.
  const aliasNameDatalistId = `alias-name-suggestions-${useId()}`

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
            {aliasEntries.map(([name, row]) => (
              <AliasRow
                key={name}
                name={name}
                row={row}
                enabledIds={enabledIds}
                executorPlugins={executorPlugins}
                models={modelsByProvider[row.provider]}
                usages={usagesByAlias.get(name) ?? []}
                aliasNameDatalistId={aliasNameDatalistId}
                existingAliasNames={Object.keys(draft.llmAliases)}
                onRename={renameAlias}
                onUpdate={updateAliasField}
                onRemove={removeAlias}
              />
            ))}
          </div>
        )}

        {/*
          Shared <datalist> for every alias-name input. Suggests names
          the user has referenced from workflow YAML (planning, coding,
          openai-fast, …) but not yet defined here. Native datalist
          gives us a real dropdown while still allowing free-text for
          inventing brand-new alias names — exactly the "choose or
          type" UX requested.
        */}
        <datalist id={aliasNameDatalistId}>
          {undefinedReferenced.map(n => (
            <option key={n} value={n} />
          ))}
        </datalist>
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

// ── AliasRow ──────────────────────────────────────────────────────
//
// Single row in the alias table. Lives in its own component so the
// alias-name input can buffer keystrokes locally and only commit the
// rename to the parent map on blur / Enter. The parent map is keyed
// by alias name, so a per-keystroke rename would mutate the React
// `key`, unmount/remount the row, and eat focus on every character —
// which is exactly the bug we're fixing.
//
// Model is *always* a real <select>: the runner enforces a fixed
// catalogue per provider, and free-typing model ids is too easy to
// get wrong. If a provider exposes no catalogue we surface a
// disabled note rather than a free-text fallback.

interface AliasRowProps {
  name: string
  row: LlmAliasConfig
  enabledIds: string[]
  executorPlugins: PluginEntry[]
  models: ModelDescriptor[] | null | undefined
  usages: AliasUsage[]
  aliasNameDatalistId: string
  existingAliasNames: string[]
  onRename: (oldName: string, newName: string) => void
  onUpdate: (name: string, patch: Partial<LlmAliasConfig>) => void
  onRemove: (name: string) => void
}

function AliasRow({
  name,
  row,
  enabledIds,
  executorPlugins,
  models,
  usages,
  aliasNameDatalistId,
  existingAliasNames,
  onRename,
  onUpdate,
  onRemove,
}: AliasRowProps) {
  // Buffered alias-name state. Synced from the parent prop whenever
  // it actually changes, but otherwise owned by the row so typing
  // doesn't churn the parent map.
  const [draftName, setDraftName] = useState(name)
  const lastSyncedName = useRef(name)
  useEffect(() => {
    if (name !== lastSyncedName.current) {
      setDraftName(name)
      lastSyncedName.current = name
    }
  }, [name])

  const trimmed = draftName.trim()
  const isDirty = trimmed !== name
  const collides = isDirty && trimmed.length > 0 && existingAliasNames.includes(trimmed)
  const isEmpty = isDirty && trimmed.length === 0

  const commitRename = () => {
    if (!isDirty) return
    if (collides || isEmpty) {
      // Reject — snap back to the canonical name so the field stays
      // consistent with the actual config.
      setDraftName(name)
      return
    }
    onRename(name, trimmed)
    lastSyncedName.current = trimmed
  }

  const helpId = `alias-help-${name}`
  const modelLoading = models === null
  const modelEmpty = Array.isArray(models) && models.length === 0

  return (
    <div className="space-y-1.5">
      <div className="grid gap-2 rounded-xl border border-line bg-canvas/40 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-end">
        <Field label="Alias">
          <Input
            value={draftName}
            list={aliasNameDatalistId}
            onChange={e => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLInputElement).blur()
              } else if (e.key === 'Escape') {
                setDraftName(name)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            placeholder="coding"
            aria-invalid={collides || isEmpty || undefined}
            aria-describedby={helpId}
            className={collides || isEmpty ? 'border-danger-400/60' : undefined}
          />
        </Field>
        <Field label="Provider">
          <select
            value={row.provider}
            onChange={e => onUpdate(name, { provider: e.target.value, model: '' })}
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
          <select
            value={row.model}
            onChange={e => onUpdate(name, { model: e.target.value })}
            disabled={!row.provider || modelLoading || modelEmpty}
            className="w-full rounded-xl border border-line bg-overlay px-3 py-2 text-sm text-fg disabled:opacity-60"
          >
            <option value="">
              {!row.provider
                ? '(pick a provider first)'
                : modelLoading
                  ? 'Loading…'
                  : modelEmpty
                    ? '(no models published by this provider)'
                    : '(select)'}
            </option>
            {/*
              Include the currently-saved model even if it isn't in
              the freshly-fetched catalogue, so an out-of-date config
              still renders its own value instead of silently
              clearing.
            */}
            {row.model && !(models ?? []).some(m => m.id === row.model) ? (
              <option value={row.model}>{row.model} (unknown)</option>
            ) : null}
            {(models ?? []).map(m => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onRemove(name)}
          aria-label={`Remove ${name}`}
        >
          <Trash2 />
        </Button>
      </div>

      {/*
        Footer: validation error first, then workflow usages. The
        "Used in" line answers "will renaming this break a workflow?"
        at a glance — the most common follow-up question once you have
        more than one provider in the mix.
      */}
      <div id={helpId} className="px-1 text-[11px] leading-4 text-fg-subtle">
        {collides ? (
          <span className="text-danger-400">An alias with that name already exists.</span>
        ) : isEmpty ? (
          <span className="text-danger-400">Alias name cannot be empty.</span>
        ) : usages.length > 0 ? (
          <span>
            <span className="text-fg-muted">Used in:</span>{' '}
            {usages.map((u, i) => (
              <span key={`${u.workflowId}-${u.phaseName}-${i}`}>
                {i > 0 ? ', ' : null}
                <span className="font-mono">{u.workflowId}</span>
                <span className="text-fg-subtle"> · {u.phaseName}</span>
              </span>
            ))}
          </span>
        ) : (
          <span className="opacity-70">Not referenced by any workflow yet.</span>
        )}
      </div>
    </div>
  )
}
