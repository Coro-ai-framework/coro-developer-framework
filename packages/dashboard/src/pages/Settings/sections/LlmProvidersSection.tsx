import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import SettingsSection from '../../../components/settings/SettingsSection'
import SettingsNotice from '../../../components/settings/SettingsNotice'
import Field from '../../../components/forms/field'
import { Input } from '../../../components/ui/input'
import { Button } from '../../../components/ui/button'
import { jsonRequest, requestJson } from '../../../lib/http'
import type { TestConnectionResult } from '../../../components/settings/TestConnectionButton'
import ModelPicker from '../../../components/llm/ModelPicker'
import {
  useProviderModels,
  type ProviderModelDescriptor,
} from '../../../components/llm/useProviderModels'
import {
  useSettings,
  type LlmAliasConfig,
  type PluginEntry,
} from '../SettingsContext'
import { evaluateReadiness } from '../readiness'
import PluginConfigCard from './PluginConfigCard'

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
    phases?: Array<{ name: string; model?: string; tier?: string }>
  }>
}

/**
 * Hit `POST /test/llm` with the draft config and translate the
 * runner's response into the {@link TestConnectionResult} shape the
 * generic button expects. The runner now dispatches every probe
 * through the plugin's own `testConnection()` method, so the same
 * code path covers Anthropic, OpenAI, and any future drop-in
 * executor — the dashboard does no provider branching.
 */
async function testLlmProvider(
  providerId: string,
  config: Record<string, unknown>,
): Promise<TestConnectionResult> {
  try {
    const result = await requestJson<TestConnectionResult>(
      '/test/llm',
      jsonRequest({ provider: providerId, config }, { method: 'POST' }),
    )
    return result
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Canonical capability-tier aliases every LLM plugin publishes
 * (`tier:planning` / `tier:coding` / `tier:mini`). These are the
 * baseline aliases the resolver falls through to when a workflow
 * phase doesn't pin a `model:`. Surfaced as the always-present top
 * group in the aliases editor so a fresh install can answer the
 * question "what do I need to set?" in one glance.
 */
const TIER_ALIAS_KEYS = ['tier:planning', 'tier:coding', 'tier:mini'] as const

type AliasKind = 'tier' | 'declared' | 'custom'

/**
 * Bucket an alias name into one of the three editor groups.
 *  - `tier`     — starts with `tier:` (canonical capability slot).
 *  - `declared` — referenced by a workflow phase (either via `model:`
 *                 or via `tier:` indirection picked up by
 *                 {@link useAliasUsages}).
 *  - `custom`   — user-invented; not referenced anywhere yet.
 */
function kindOf(name: string, referenced: Set<string>): AliasKind {
  if (name.startsWith('tier:')) return 'tier'
  if (referenced.has(name)) return 'declared'
  return 'custom'
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
        const push = (key: string, usage: AliasUsage) => {
          const list = map.get(key) ?? []
          list.push(usage)
          map.set(key, list)
        }
        for (const wf of data.workflows ?? []) {
          for (const phase of wf.phases ?? []) {
            const usage = { workflowId: wf.id, workflowName: wf.name, phaseName: phase.name }
            const m = (phase.model ?? '').trim()
            if (m) push(m, usage)
            // A phase always has a tier (defaults to 'coding' on the
            // server side), so every phase contributes to a `tier:*`
            // usage entry. This is what makes the tier rows in the
            // editor self-explanatory: "Used in: job · planning, …".
            const t = (phase.tier ?? '').trim()
            if (t) push(`tier:${t}`, usage)
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

/**
 * Lists every executor plugin (LLM provider) discovered in the
 * runner's catalogue, plus the multi-provider routing surface
 * (`defaultProvider` + per-alias `{provider, model}` pairs).
 *
 * Provider-specific configuration (Claude OAuth, an Anthropic API
 * key, an OpenAI key + base URL, …) is rendered by
 * {@link PluginConfigCard}. Plugins that need a richer flow opt
 * into a custom panel via `manifest.ui.customPanel`.
 *
 * The FTUE wizard previously embedded this section directly with an
 * `embedded` + `onConnected` flag. That mode is gone — the wizard
 * now has its own purpose-built LLM step with a curated minimal
 * field set. This component is for Settings power users only.
 */
export default function LlmProvidersSection() {
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

  // Per-provider model cache, shared with every other LLM picker
  // surface (e.g. PhaseModelPopover on Job Detail). The hook owns
  // network + state machine; we just pass it through to ModelPicker.
  const { modelsByProvider, loadModels } = useProviderModels()

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

  // Set used by `kindOf` to bucket each alias.
  const referencedSet = useMemo(() => new Set(referencedNames), [referencedNames])

  // Names that workflows reference but the user hasn't yet defined as
  // an alias — these are the highest-value suggestions when adding a
  // new alias because they're literally what the workflows expect.
  const undefinedReferenced = useMemo(
    () => referencedNames.filter(n => !(n in draft.llmAliases) && !n.startsWith('tier:')),
    [referencedNames, draft.llmAliases],
  )

  // Tier rows that the user hasn't defined yet — render them as
  // "ghost" rows so the editor can prompt the user to define them
  // without forcing them to read documentation first.
  const missingTierKeys = useMemo(
    () => TIER_ALIAS_KEYS.filter(k => !(k in draft.llmAliases)),
    [draft.llmAliases],
  )

  // Partition the existing aliases into the three rendering groups.
  // Insertion order is preserved within each bucket so renames don't
  // visually scramble the list.
  const grouped = useMemo(() => {
    const tiers: Array<[string, LlmAliasConfig]> = []
    const declared: Array<[string, LlmAliasConfig]> = []
    const custom: Array<[string, LlmAliasConfig]> = []
    for (const entry of aliasEntries) {
      const k = kindOf(entry[0], referencedSet)
      if (k === 'tier') tiers.push(entry)
      else if (k === 'declared') declared.push(entry)
      else custom.push(entry)
    }
    return { tiers, declared, custom }
  }, [aliasEntries, referencedSet])

  // Custom group is collapsed by default — power-user surface, no
  // need to dominate first-paint for the common case where the user
  // only fills in tiers.
  const [showCustom, setShowCustom] = useState(false)

  // Define a missing tier on click — pre-fills provider with the
  // current default so the user only has to pick a model.
  const defineTier = (tierKey: string) => {
    updateAliases({
      ...draft.llmAliases,
      [tierKey]: {
        provider: defaultProviderValue || enabledIds[0] || '',
        model: '',
      },
    })
  }

  // Shared datalist id so every alias-name input pulls from the same
  // suggestion pool.
  const aliasNameDatalistId = `alias-name-suggestions-${useId()}`

  return (
    <SettingsSection
      title="LLM providers"
      description="Configure one or more model providers and route workflow aliases to specific provider/model pairs."
      required
      status={readiness.status}
      statusLabel={readiness.label}
    >
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
              onTest={config => testLlmProvider(plugin.manifest.id, config)}
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

      <div className="rounded-2xl border border-line bg-overlay/30 px-4 py-3.5 space-y-4">
        <div>
          <div className="text-sm font-medium text-fg">Aliases</div>
          <div className="text-[12px] text-fg-muted">
            Workflow shorthands that map to a concrete <span className="font-mono">provider/model</span> pair.
            Three groups, in increasing specificity:
          </div>
          <ul className="mt-1.5 space-y-0.5 text-[12px] text-fg-subtle">
            <li>
              <span className="font-medium text-fg-muted">Tiers</span> — capability slots every workflow defaults to (planning / coding / mini).
            </li>
            <li>
              <span className="font-medium text-fg-muted">Workflow-declared</span> — alias names a specific workflow phase pins via <span className="font-mono">model:</span>.
            </li>
            <li>
              <span className="font-medium text-fg-muted">Custom</span> — anything you've added that no workflow references yet.
            </li>
          </ul>
        </div>

        {/* ── Tiers (always rendered) ─────────────────────────────────── */}
        <AliasGroup
          title="Tiers"
          subtitle="Workflow defaults. Every install needs these — workflows fall back to the matching tier when a phase doesn't pin a model."
        >
          {grouped.tiers.map(([name, row]) => (
            <AliasRow
              key={name}
              name={name}
              row={row}
              kind="tier"
              nameLocked
              enabledIds={enabledIds}
              executorPlugins={executorPlugins}
              modelsByProvider={modelsByProvider}
              loadModels={loadModels}
              usages={usagesByAlias.get(name) ?? []}
              aliasNameDatalistId={aliasNameDatalistId}
              existingAliasNames={Object.keys(draft.llmAliases)}
              onRename={renameAlias}
              onUpdate={updateAliasField}
              onRemove={removeAlias}
            />
          ))}
          {missingTierKeys.length > 0 ? (
            <div className="space-y-1.5">
              {missingTierKeys.map(tierKey => (
                <div
                  key={tierKey}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-warning-400/50 bg-warning-50/5 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <div className="font-mono text-sm text-fg">{tierKey}</div>
                    <div className="text-[11px] text-fg-subtle">
                      Not defined in this draft. Active LLM plugins re-seed tier defaults
                      on every runner start — click Define to pin one explicitly.
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => defineTier(tierKey)}
                    disabled={enabledIds.length === 0}
                  >
                    Define
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </AliasGroup>

        {/* ── Workflow-declared (only when present) ───────────────────── */}
        {grouped.declared.length > 0 || undefinedReferenced.length > 0 ? (
          <AliasGroup
            title="Workflow-declared"
            subtitle="Alias names referenced explicitly by a workflow phase via its model: field."
          >
            {grouped.declared.map(([name, row]) => (
              <AliasRow
                key={name}
                name={name}
                row={row}
                kind="declared"
                nameLocked
                enabledIds={enabledIds}
                executorPlugins={executorPlugins}
                modelsByProvider={modelsByProvider}
              loadModels={loadModels}
                usages={usagesByAlias.get(name) ?? []}
                aliasNameDatalistId={aliasNameDatalistId}
                existingAliasNames={Object.keys(draft.llmAliases)}
                onRename={renameAlias}
                onUpdate={updateAliasField}
                onRemove={removeAlias}
              />
            ))}
            {undefinedReferenced.length > 0 ? (
              <div className="space-y-1.5">
                {undefinedReferenced.map(name => {
                  const usages = usagesByAlias.get(name) ?? []
                  return (
                    <div
                      key={name}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-warning-400/50 bg-warning-50/5 px-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <div className="font-mono text-sm text-fg">{name}</div>
                        <div className="text-[11px] text-fg-subtle">
                          Needs definition · used by{' '}
                          {usages.map((u, i) => (
                            <span key={`${u.workflowId}-${u.phaseName}-${i}`}>
                              {i > 0 ? ', ' : null}
                              <span className="font-mono">{u.workflowId}</span>
                              <span className="opacity-70"> · {u.phaseName}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          updateAliases({
                            ...draft.llmAliases,
                            [name]: {
                              provider: defaultProviderValue || enabledIds[0] || '',
                              model: '',
                            },
                          })
                        }
                        disabled={enabledIds.length === 0}
                      >
                        Define
                      </Button>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </AliasGroup>
        ) : null}

        {/* ── Custom (collapsed by default) ───────────────────────────── */}
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowCustom(s => !s)}
            className="flex w-full items-center justify-between gap-2 text-left text-sm font-medium text-fg-muted hover:text-fg"
          >
            <span>
              Custom <span className="text-fg-subtle">({grouped.custom.length})</span>
            </span>
            <span className="text-[11px] text-fg-subtle">{showCustom ? 'Hide' : 'Show'}</span>
          </button>
          {showCustom ? (
            <>
              <div className="text-[12px] text-fg-subtle">
                Free-form aliases not referenced by any workflow. Useful for ad-hoc experiments.
              </div>
              <div className="space-y-2">
                {grouped.custom.map(([name, row]) => (
                  <AliasRow
                    key={name}
                    name={name}
                    row={row}
                    kind="custom"
                    enabledIds={enabledIds}
                    executorPlugins={executorPlugins}
                    modelsByProvider={modelsByProvider}
              loadModels={loadModels}
                    usages={usagesByAlias.get(name) ?? []}
                    aliasNameDatalistId={aliasNameDatalistId}
                    existingAliasNames={Object.keys(draft.llmAliases)}
                    onRename={renameAlias}
                    onUpdate={updateAliasField}
                    onRemove={removeAlias}
                  />
                ))}
              </div>
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={addAlias}
                  disabled={enabledIds.length === 0}
                >
                  <Plus />
                  Add alias
                </Button>
              </div>
            </>
          ) : null}
        </div>

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
    </SettingsSection>
  )
}

// ── AliasGroup ────────────────────────────────────────────────────
//
// Tiny presentational wrapper for one of the three alias buckets.
// Pulled out so the section markup stays declarative ("Tiers, then
// Workflow-declared, then Custom") instead of duplicating heading +
// subtitle + list-container styles per group.

function AliasGroup({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: ReactNode
}) {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-sm font-medium text-fg">{title}</div>
        <div className="text-[12px] text-fg-subtle">{subtitle}</div>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
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
  /**
   * Which group is this row rendered in? Drives subtle copy
   * differences (the empty "Used in" footer reads differently for
   * tier rows vs custom rows) and gating (delete is hidden for
   * tier rows because removing a tier breaks every workflow that
   * doesn't pin a model).
   */
  kind: AliasKind
  /**
   * When true, the alias-name input is read-only. Used for tier and
   * declared rows whose names are dictated by the workflow contract
   * — renaming them would silently de-reference the workflow.
   */
  nameLocked?: boolean
  enabledIds: string[]
  executorPlugins: PluginEntry[]
  /**
   * Per-provider model cache and loader, threaded through to the
   * embedded {@link ModelPicker}. Lifted to the parent so a single
   * fetch is shared across every alias row.
   */
  modelsByProvider: Record<string, ProviderModelDescriptor[] | null | undefined>
  loadModels: (providerId: string) => Promise<void>
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
  kind,
  nameLocked = false,
  enabledIds,
  executorPlugins,
  modelsByProvider,
  loadModels,
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

  return (
    <div className="space-y-1.5">
      <div className="grid gap-2 rounded-xl border border-line bg-canvas/40 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-end">
        <Field label="Alias">
          <Input
            value={draftName}
            list={nameLocked ? undefined : aliasNameDatalistId}
            readOnly={nameLocked}
            tabIndex={nameLocked ? -1 : undefined}
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
            className={
              [
                collides || isEmpty ? 'border-danger-400/60' : '',
                nameLocked ? 'cursor-default bg-overlay/40 font-mono' : '',
              ].filter(Boolean).join(' ') || undefined
            }
          />
        </Field>
        <div className="sm:col-span-2">
          <ModelPicker
            value={{ provider: row.provider, model: row.model }}
            onChange={next => {
              // ModelPicker emits both fields together. We forward the
              // patch wholesale so a provider switch correctly clears
              // the model in the saved config (matches the previous
              // inline-select behaviour).
              onUpdate(name, { provider: next.provider, model: next.model })
            }}
            providers={enabledIds.map(id => ({
              id,
              displayName:
                executorPlugins.find(p => p.manifest.id === id)?.manifest.displayName ?? id,
            }))}
            modelsByProvider={modelsByProvider}
            loadModels={loadModels}
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onRemove(name)}
          aria-label={`Remove ${name}`}
          // Tier aliases are part of the workflow contract — removing
          // one would break every workflow that doesn't pin a model.
          // Render the slot as disabled instead of yanking it so the
          // grid columns stay aligned across rows.
          disabled={kind === 'tier'}
          title={kind === 'tier' ? 'Tier aliases are required by every workflow.' : undefined}
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
