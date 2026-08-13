import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { CoachModeConfig, IntakeConfig } from '../../lib/coach-mode'
import { ApiError, jsonRequest, requestJson } from '../../lib/http'

// ── Persisted config shapes ─────────────────────────────────────────────────
//
// LLM-provider-specific shapes (Anthropic Claude login state, OAuth
// accounts, etc.) are configured via each plugin manifest's
// `auth.methods` and rendered by {@link GenericAuthPanel}.

export interface McpServerEntry {
  type: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
  planMode?: boolean
  allowedTools?: string[]
  disallowedTools?: string[]
}

export interface PluginInstalledEntry {
  enabled?: boolean
  config: Record<string, unknown>
}

export interface PluginsConfigShape {
  defaults?: { scm?: string; tracker?: string }
  installed?: Record<string, PluginInstalledEntry>
}

// ── Plugin manifests (from /plugins) ────────────────────────────────────────
//
// We fetch the runner's `/plugins` endpoint alongside `/config` so that
// every Settings consumer (sections + readiness) can render plugin
// cards driven by the canonical `manifest.configSchema` (JSON Schema)
// without duplicating a per-plugin field map.

export interface PluginManifestSummary {
  id: string
  kind: 'scm' | 'tracker' | 'executor' | string
  version: string
  displayName: string
  hostCompatibility: string
  capabilities?: Record<string, boolean>
  configSchema: unknown
  /**
   * Optional UI hints surfaced by the plugin manifest. Auth flows are
   * rendered generically from `auth.methods` via {@link GenericAuthPanel}.
   */
  ui?: { customPanel?: string; subtitle?: string; recommendedForOnboarding?: boolean }
}

export interface PluginEntry {
  manifest: PluginManifestSummary
  installed: boolean
  configured?: boolean
  active?: boolean
  available?: boolean
  activationHint?: string
  source?: 'builtin' | 'dropin'
  mcpServer?: { type: string; command?: string; args?: string[]; url?: string } | null
}

export interface PluginsCatalogue {
  plugins: PluginEntry[]
  defaults: { scm?: string; tracker?: string }
  webhookBaseUrl: string | null
}

/**
 * One alias → {provider, model} entry. Mirrors the runner-side
 * `LlmAliasConfig`. The optional `reasoningEffort` is forwarded to
 * executors that honour it (Anthropic ignores it today).
 */
export interface LlmAliasConfig {
  provider: string
  model: string
  reasoningEffort?: 'low' | 'medium' | 'high'
}

export interface LlmConfigShape {
  defaultProvider?: string
  aliases?: Record<string, LlmAliasConfig>
}

/**
 * Upstream contribution destination. Mirrors `upstreamConfigSchema` in the
 * runner's `config/local-config.ts`. `token` arrives redacted (`ghp_…abcd`)
 * and is echoed back unchanged unless the operator types a new one.
 */
export interface UpstreamConfigShape {
  repoUrl?: string
  forkOwner?: string
  token?: string
  maxIssuesPerRun?: number
  maxCodeJobsPerRun?: number
}

export interface ConfigResponse {
  config: {
    /**
     * Multi-provider routing. `defaultProvider` is the executor plugin
     * id used when an alias / phase doesn't pin one explicitly;
     * `aliases` maps workflow shorthands like `planning` / `coding`
     * to a concrete `{provider, model}` pair. Provider configs
     * themselves live under `plugins.installed.<id>.config`.
     */
    llm?: LlmConfigShape
    intelligence?: { dir: string; gitRemote?: string }
    paths?: { workingDir: string }
    cloud?: { url: string; token: string }
    plugins?: PluginsConfigShape
    mcpServers?: Record<string, McpServerEntry>
    inheritClaudeCodeMcps?: boolean
    /** FTUE wizard completion. Server-side fallback for the browser
     * localStorage flag — when present, the dashboard no longer
     * auto-launches the wizard on a fresh browser. */
    setup?: { completedAt?: string; skipped?: Array<'llm' | 'scm' | 'tracker'> }
    coachMode?: CoachModeConfig
    intake?: IntakeConfig
    guardrails?: {
      enabled?: boolean
      rules?: Array<{
        id: string
        enabled?: boolean
        on?: string
        check?: string
        config?: Record<string, unknown>
        script?: string
      }>
    }
    /** Where retrospective findings about Coro itself get published. */
    upstream?: UpstreamConfigShape
  } | null
  configPath: string
  mode: 'hybrid' | 'local' | 'legacy'
  resolved: {
    intelligenceDir: string
    workingDir: string
    guardrails?: {
      enabled: boolean
      rules: GuardrailRuleDraft[]
      scriptsDir: string
    }
    /**
     * True when the runner can actually publish upstream. Not the same as
     * `config.upstream` being present: the env vars configure it too, and
     * only `repoUrl` is load-bearing.
     */
    upstreamConfigured?: boolean
  }
  configError?: string
  rawConfig?: unknown
}

// ── Guardrails (effective rules from GET /config resolved.guardrails) ───────

export interface GuardrailRuleDraft {
  id: string
  title?: string
  description?: string
  enabled: boolean
  on: string
  check: string
  config?: Record<string, unknown>
  during?: string[]
  script?: string
  source?: 'bundled' | 'override' | 'custom'
  scriptFileExists?: boolean
}

// ── Draft (the unified, dirty-tracked form state) ───────────────────────────

export interface SettingsDraft {
  // LLM routing (multi-provider). Provider auth lives in the matching
  // plugin entry under `pluginInstalled` — this draft only holds the
  // routing surface (default provider + alias map).
  llmDefaultProvider: string
  llmAliases: Record<string, LlmAliasConfig>
  // Plugins (auth + per-provider config; replaces legacy single-slot
  // git + tracker + anthropic draft fields)
  pluginInstalled: Record<string, PluginInstalledEntry>
  pluginDefaultScm: string
  pluginDefaultTracker: string
  // MCP
  mcpServersText: string
  inheritClaudeCodeMcps: boolean
  // Paths
  intelligenceDir: string
  intelligenceRemote: string
  workingDir: string
  // Guardrails
  guardrailsEnabled: boolean
  guardrailRules: GuardrailRuleDraft[]
  guardrailsRulesText: string
  // Upstream contribution. Counts are held as text so an empty field
  // means "use the default" rather than zero, which would silently
  // disable publishing.
  upstreamRepoUrl: string
  upstreamForkOwner: string
  upstreamToken: string
  upstreamMaxIssuesPerRun: string
  upstreamMaxCodeJobsPerRun: string
}

const EMPTY_DRAFT: SettingsDraft = {
  llmDefaultProvider: '',
  llmAliases: {},
  pluginInstalled: {},
  pluginDefaultScm: '',
  pluginDefaultTracker: '',
  mcpServersText: '{}',
  inheritClaudeCodeMcps: false,
  intelligenceDir: '',
  intelligenceRemote: '',
  workingDir: '',
  guardrailsEnabled: true,
  guardrailRules: [],
  guardrailsRulesText: '[]',
  upstreamRepoUrl: '',
  upstreamForkOwner: '',
  upstreamToken: '',
  upstreamMaxIssuesPerRun: '',
  upstreamMaxCodeJobsPerRun: '',
}

// ── Section identity ────────────────────────────────────────────────────────

export type SettingsSectionId =
  | 'general'
  | 'llm-provider'
  | 'source-control'
  | 'issue-tracker'
  | 'plugins'
  | 'mcp'
  | 'paths'
  | 'guardrails'
  | 'contribution'

/** Static (non-plugin) field → section. Plugin entries are mapped
 * dynamically via the plugin manifest kind. */
const STATIC_FIELD_TO_SECTION: Partial<Record<keyof SettingsDraft, SettingsSectionId>> = {
  llmDefaultProvider: 'llm-provider',
  llmAliases: 'llm-provider',
  pluginDefaultScm: 'source-control',
  pluginDefaultTracker: 'issue-tracker',
  mcpServersText: 'mcp',
  inheritClaudeCodeMcps: 'mcp',
  intelligenceDir: 'paths',
  intelligenceRemote: 'paths',
  workingDir: 'paths',
  guardrailsEnabled: 'guardrails',
  guardrailRules: 'guardrails',
  guardrailsRulesText: 'guardrails',
  upstreamRepoUrl: 'contribution',
  upstreamForkOwner: 'contribution',
  upstreamToken: 'contribution',
  upstreamMaxIssuesPerRun: 'contribution',
  upstreamMaxCodeJobsPerRun: 'contribution',
}

// ── Context shape ───────────────────────────────────────────────────────────

export interface SettingsMeta {
  configPath: string
  mode: ConfigResponse['mode']
  resolved: ConfigResponse['resolved']
  configError?: string
  rawConfig?: unknown
}

interface SettingsContextValue {
  // Lifecycle
  loading: boolean
  loadError: string | null
  reload: () => Promise<void>
  // Draft
  draft: SettingsDraft
  setDraft: <K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => void
  /** Plugin-specific helpers — drive the schema-driven plugin cards. */
  setPluginField: (pluginId: string, field: string, value: unknown) => void
  setPluginEnabled: (pluginId: string, enabled: boolean) => void
  setPluginDefault: (kind: 'scm' | 'tracker', pluginId: string) => void
  setGuardrailRuleEnabled: (ruleId: string, enabled: boolean) => void
  setGuardrailRuleConfig: (ruleId: string, config: Record<string, unknown>) => void
  isDirty: boolean
  dirtyFields: Set<keyof SettingsDraft>
  dirtyPluginIds: Set<string>
  dirtySections: Set<SettingsSectionId>
  discardChanges: () => void
  // Save
  save: () => Promise<void>
  saving: boolean
  saveError: string | null
  saveNotice: string | null
  clearSaveFeedback: () => void
  lastSavedAt: string | null
  // Meta
  meta: SettingsMeta | null
  // Plugins catalogue (manifests + activation state) — fetched alongside /config.
  pluginsCatalogue: PluginsCatalogue | null
  pluginsCatalogueError: string | null
  reloadPlugins: () => Promise<void>
  // First run — preferred source is server-side `config.setup.completedAt`
  // (persisted via PUT /config). The browser localStorage flag is kept as
  // a fallback for older runners and for instant client-side state after
  // the wizard finishes.
  firstRunCompleted: boolean
  markFirstRunComplete: (opts?: { skipped?: Array<'llm' | 'scm' | 'tracker'> }) => Promise<void>
  resetFirstRun: () => void
  /** Server-side coach mode + intake preferences (from GET /config). */
  preferences: { coachMode?: CoachModeConfig; intake?: IntakeConfig } | null
  /**
   * Commit a single FTUE step's draft into the global config + persist
   * immediately. Used by SetupWizard so that each verified step
   * survives a closed browser before the user finishes the wizard.
   */
  commitWizardStep: (input: {
    kind: 'scm' | 'tracker' | 'executor'
    pluginId: string
    config: Record<string, unknown>
    setAsDefault?: boolean
  }) => Promise<void>
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within <SettingsProvider>')
  return ctx
}

// ── Provider ────────────────────────────────────────────────────────────────

function configToDraft(response: ConfigResponse): SettingsDraft {
  const cfg = response.config
  if (!cfg) return EMPTY_DRAFT
  const mcpJson = JSON.stringify(cfg.mcpServers ?? {}, null, 2)

  // Plugin-installed entries are the single source of truth for
  // every provider credential (LLM, SCM, tracker). The legacy
  // single-slot `git` / `tracker` blocks were removed in the
  // single-source-of-truth refactor.
  const installed: Record<string, PluginInstalledEntry> = {}
  let defaultScm = ''
  let defaultTracker = ''
  if (cfg.plugins?.installed) {
    for (const [id, entry] of Object.entries(cfg.plugins.installed)) {
      installed[id] = {
        ...(typeof entry.enabled === 'boolean' ? { enabled: entry.enabled } : {}),
        config: { ...(entry.config ?? {}) },
      }
    }
    defaultScm = cfg.plugins.defaults?.scm ?? ''
    defaultTracker = cfg.plugins.defaults?.tracker ?? ''
  }

  const guardrailRules = (response.resolved?.guardrails?.rules ?? []).map(r => ({
    ...r,
    enabled: r.enabled !== false,
  }))
  const guardrailsRulesText = JSON.stringify(cfg?.guardrails?.rules ?? [], null, 2)

  return {
    llmDefaultProvider: cfg.llm?.defaultProvider ?? '',
    llmAliases: { ...(cfg.llm?.aliases ?? {}) },
    pluginInstalled: installed,
    pluginDefaultScm: defaultScm,
    pluginDefaultTracker: defaultTracker,
    mcpServersText: mcpJson,
    inheritClaudeCodeMcps: cfg.inheritClaudeCodeMcps === true,
    intelligenceDir: cfg.intelligence?.dir ?? '',
    intelligenceRemote: cfg.intelligence?.gitRemote ?? '',
    workingDir: cfg.paths?.workingDir ?? '',
    guardrailsEnabled: response.resolved?.guardrails?.enabled ?? cfg?.guardrails?.enabled ?? true,
    guardrailRules,
    guardrailsRulesText,
    upstreamRepoUrl: cfg.upstream?.repoUrl ?? '',
    upstreamForkOwner: cfg.upstream?.forkOwner ?? '',
    upstreamToken: cfg.upstream?.token ?? '',
    upstreamMaxIssuesPerRun: numberToText(cfg.upstream?.maxIssuesPerRun),
    upstreamMaxCodeJobsPerRun: numberToText(cfg.upstream?.maxCodeJobsPerRun),
  }
}

/** Blank for an unset count, so the form can show the runner's default. */
function numberToText(value: number | undefined): string {
  return typeof value === 'number' ? String(value) : ''
}

/**
 * `null` for a blank or unparseable count — the server reads that as
 * "drop the override and use the default", where `undefined` would be
 * indistinguishable from "leave whatever is on disk".
 */
function textToCount(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number.parseInt(trimmed, 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

export const UPSTREAM_DRAFT_FIELDS: Array<keyof SettingsDraft> = [
  'upstreamRepoUrl',
  'upstreamForkOwner',
  'upstreamToken',
  'upstreamMaxIssuesPerRun',
  'upstreamMaxCodeJobsPerRun',
]

function draftEqualField<K extends keyof SettingsDraft>(a: SettingsDraft[K], b: SettingsDraft[K]): boolean {
  if (a === b) return true
  // Deep-compare object-shaped fields (pluginInstalled). Cheap and
  // correct for the small JSON-ish shapes we store.
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }
  return false
}

interface SettingsProviderProps {
  children: ReactNode
}

export function SettingsProvider({ children }: SettingsProviderProps) {
  const [draft, setDraftState] = useState<SettingsDraft>(EMPTY_DRAFT)
  const [baseline, setBaseline] = useState<SettingsDraft>(EMPTY_DRAFT)
  const [meta, setMeta] = useState<SettingsMeta | null>(null)
  const [preferences, setPreferences] = useState<SettingsContextValue['preferences']>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const [pluginsCatalogue, setPluginsCatalogue] = useState<PluginsCatalogue | null>(null)
  const [pluginsCatalogueError, setPluginsCatalogueError] = useState<string | null>(null)

  const [firstRunCompleted, setFirstRunCompleted] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('coro.firstRun.completed') === 'true'
  })

  const baselineRef = useRef(baseline)
  baselineRef.current = baseline

  const reloadPlugins = useCallback(async () => {
    try {
      const data = await requestJson<PluginsCatalogue>('/plugins')
      setPluginsCatalogue(data)
      setPluginsCatalogueError(null)
    } catch (err) {
      setPluginsCatalogueError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [data] = await Promise.all([
        requestJson<ConfigResponse>('/config'),
        reloadPlugins(),
      ])
      setMeta({
        configPath: data.configPath,
        mode: data.mode,
        resolved: data.resolved,
        configError: data.configError,
        rawConfig: data.rawConfig,
      })
      setPreferences({
        coachMode: data.config?.coachMode,
        intake: data.config?.intake,
      })

      // Server-side FTUE completion wins over the browser flag. This is
      // how the dashboard avoids re-prompting a user who finished setup
      // on a different browser / device.
      if (data.config?.setup?.completedAt) {
        setFirstRunCompleted(true)
        if (typeof window !== 'undefined') {
          window.localStorage.setItem('coro.firstRun.completed', 'true')
        }
      }

      const nextDraft = configToDraft(data)
      setDraftState(nextDraft)
      setBaseline(nextDraft)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [reloadPlugins])

  useEffect(() => {
    void reload()
  }, [reload])

  const setDraft = useCallback(<K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => {
    setDraftState(previous => ({ ...previous, [key]: value }))
    // Touching the draft clears stale save feedback.
    setSaveError(null)
    setSaveNotice(null)
  }, [])

  const setPluginField = useCallback((pluginId: string, field: string, value: unknown) => {
    setDraftState(previous => {
      const prevEntry = previous.pluginInstalled[pluginId] ?? { config: {} }
      const nextConfig = { ...prevEntry.config }
      if (value === undefined || value === '') {
        // Empty string means "clear" — drop the key so we don't write
        // empty strings to disk. The user can re-enter to restore.
        delete nextConfig[field]
      } else {
        nextConfig[field] = value
      }
      return {
        ...previous,
        pluginInstalled: {
          ...previous.pluginInstalled,
          [pluginId]: { ...prevEntry, config: nextConfig },
        },
      }
    })
    setSaveError(null)
    setSaveNotice(null)
  }, [])

  const setPluginEnabled = useCallback((pluginId: string, enabled: boolean) => {
    setDraftState(previous => {
      const prevEntry = previous.pluginInstalled[pluginId] ?? { config: {} }
      return {
        ...previous,
        pluginInstalled: {
          ...previous.pluginInstalled,
          [pluginId]: { ...prevEntry, enabled },
        },
      }
    })
    setSaveError(null)
    setSaveNotice(null)
  }, [])

  const setPluginDefault = useCallback((kind: 'scm' | 'tracker', pluginId: string) => {
    setDraftState(previous =>
      kind === 'scm'
        ? { ...previous, pluginDefaultScm: pluginId }
        : { ...previous, pluginDefaultTracker: pluginId },
    )
    setSaveError(null)
    setSaveNotice(null)
  }, [])

  const setGuardrailRuleEnabled = useCallback((ruleId: string, enabled: boolean) => {
    setDraftState(previous => ({
      ...previous,
      guardrailRules: previous.guardrailRules.map(r =>
        r.id === ruleId ? { ...r, enabled } : r,
      ),
    }))
    setSaveError(null)
    setSaveNotice(null)
  }, [])

  const setGuardrailRuleConfig = useCallback((ruleId: string, config: Record<string, unknown>) => {
    setDraftState(previous => ({
      ...previous,
      guardrailRules: previous.guardrailRules.map(r =>
        r.id === ruleId ? { ...r, config } : r,
      ),
    }))
    setSaveError(null)
    setSaveNotice(null)
  }, [])

  function buildGuardrailOverrides(
    current: GuardrailRuleDraft[],
    base: GuardrailRuleDraft[],
  ): Array<Record<string, unknown>> {
    const baseById = new Map(base.map(r => [r.id, r]))
    const overrides: Array<Record<string, unknown>> = []
    for (const rule of current) {
      const orig = baseById.get(rule.id)
      if (!orig) {
        overrides.push({
          id: rule.id,
          on: rule.on,
          check: rule.check,
          enabled: rule.enabled,
          ...(rule.config ? { config: rule.config } : {}),
          ...(rule.script ? { script: rule.script } : {}),
        })
        continue
      }
      const row: Record<string, unknown> = { id: rule.id }
      let changed = false
      if (rule.enabled !== orig.enabled) {
        row.enabled = rule.enabled
        changed = true
      }
      if (JSON.stringify(rule.config ?? {}) !== JSON.stringify(orig.config ?? {})) {
        row.config = rule.config ?? {}
        changed = true
      }
      if (changed) overrides.push(row)
    }
    return overrides
  }

  const dirtyFields = useMemo(() => {
    const out = new Set<keyof SettingsDraft>()
    ;(Object.keys(draft) as (keyof SettingsDraft)[]).forEach(key => {
      if (!draftEqualField(draft[key], baseline[key])) out.add(key)
    })
    return out
  }, [draft, baseline])

  // Per-plugin dirty set — driven off the deep-compared
  // `pluginInstalled` map. Sections / readiness use this to know
  // which plugin cards have unsaved edits.
  const dirtyPluginIds = useMemo(() => {
    const out = new Set<string>()
    if (!dirtyFields.has('pluginInstalled')) return out
    const draftIds = new Set(Object.keys(draft.pluginInstalled))
    const baseIds = new Set(Object.keys(baseline.pluginInstalled))
    for (const id of new Set([...draftIds, ...baseIds])) {
      const a = draft.pluginInstalled[id]
      const b = baseline.pluginInstalled[id]
      if (JSON.stringify(a) !== JSON.stringify(b)) out.add(id)
    }
    return out
  }, [dirtyFields, draft.pluginInstalled, baseline.pluginInstalled])

  const dirtySections = useMemo(() => {
    const out = new Set<SettingsSectionId>()
    dirtyFields.forEach(field => {
      const section = STATIC_FIELD_TO_SECTION[field]
      if (section) out.add(section)
    })
    if (dirtyPluginIds.size > 0) {
      // Map plugin id → section via manifest kind. Default to 'plugins'
      // if the catalogue hasn't loaded (rare race; the user can still save).
      const byId = new Map(pluginsCatalogue?.plugins.map(p => [p.manifest.id, p.manifest.kind]) ?? [])
      for (const id of dirtyPluginIds) {
        const kind = byId.get(id)
        if (kind === 'scm') out.add('source-control')
        else if (kind === 'tracker') out.add('issue-tracker')
        else out.add('plugins')
      }
    }
    return out
  }, [dirtyFields, dirtyPluginIds, pluginsCatalogue])

  const isDirty = dirtyFields.size > 0

  const discardChanges = useCallback(() => {
    setDraftState(baselineRef.current)
    setSaveError(null)
    setSaveNotice(null)
  }, [])

  const buildPayload = useCallback((): Record<string, unknown> => {
    const body: Record<string, unknown> = {}

    // LLM routing — sent only when the LLM section is dirty. The
    // server merges this against `config.llm` while leaving each
    // provider plugin's auth config (under `plugins.installed.<id>`)
    // alone unless the plugin block is also dirty below.
    if (dirtyFields.has('llmDefaultProvider') || dirtyFields.has('llmAliases')) {
      body['llm'] = {
        ...(draft.llmDefaultProvider ? { defaultProvider: draft.llmDefaultProvider } : {}),
        aliases: { ...draft.llmAliases },
      }
    }

    // Plugins — replaces the legacy single-slot `git` + `tracker` blocks.
    // We send the full pluginInstalled map (so the server can drop
    // stale entries) but only when something in this surface is dirty.
    if (
      dirtyFields.has('pluginInstalled') ||
      dirtyFields.has('pluginDefaultScm') ||
      dirtyFields.has('pluginDefaultTracker')
    ) {
      const installed: Record<string, { enabled?: boolean; config: Record<string, unknown> }> = {}
      for (const [id, entry] of Object.entries(draft.pluginInstalled)) {
        installed[id] = {
          ...(typeof entry.enabled === 'boolean' ? { enabled: entry.enabled } : {}),
          config: { ...entry.config },
        }
      }
      const defaults: Record<string, string> = {}
      if (draft.pluginDefaultScm) defaults['scm'] = draft.pluginDefaultScm
      if (draft.pluginDefaultTracker) defaults['tracker'] = draft.pluginDefaultTracker
      body['plugins'] = {
        ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
        installed,
      }
    }

    // MCP
    if (dirtyFields.has('mcpServersText')) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(draft.mcpServersText)
      } catch (err) {
        throw new Error(`MCP servers JSON is invalid: ${(err as Error).message}`)
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('mcpServers must be a JSON object keyed by server id.')
      }
      body['mcpServers'] = parsed
    }
    if (dirtyFields.has('inheritClaudeCodeMcps')) {
      body['inheritClaudeCodeMcps'] = draft.inheritClaudeCodeMcps
    }

    // Paths
    if (
      dirtyFields.has('intelligenceDir') ||
      dirtyFields.has('intelligenceRemote')
    ) {
      body['intelligence'] = {
        dir: draft.intelligenceDir || undefined,
        gitRemote: draft.intelligenceRemote || undefined,
      }
    }
    if (dirtyFields.has('workingDir')) {
      body['paths'] = { workingDir: draft.workingDir || undefined }
    }

    if (
      dirtyFields.has('guardrailsEnabled') ||
      dirtyFields.has('guardrailRules') ||
      dirtyFields.has('guardrailsRulesText')
    ) {
      let rules: Array<Record<string, unknown>>
      if (dirtyFields.has('guardrailsRulesText')) {
        const parsed = JSON.parse(draft.guardrailsRulesText) as unknown
        if (!Array.isArray(parsed)) {
          throw new Error('guardrails.rules must be a JSON array.')
        }
        rules = parsed as Array<Record<string, unknown>>
      } else {
        rules = buildGuardrailOverrides(draft.guardrailRules, baselineRef.current.guardrailRules)
      }
      body['guardrails'] = {
        enabled: draft.guardrailsEnabled,
        rules,
      }
    }

    // Upstream contribution. Sent whole so clearing the repository URL
    // reaches the server as an edit — that is how the operator turns
    // publishing back off.
    if (UPSTREAM_DRAFT_FIELDS.some(field => dirtyFields.has(field))) {
      body['upstream'] = {
        repoUrl: draft.upstreamRepoUrl.trim(),
        forkOwner: draft.upstreamForkOwner.trim(),
        // The server treats a redacted value as "unchanged", so echoing
        // what GET handed us keeps the stored token intact.
        token: draft.upstreamToken,
        maxIssuesPerRun: textToCount(draft.upstreamMaxIssuesPerRun),
        maxCodeJobsPerRun: textToCount(draft.upstreamMaxCodeJobsPerRun),
      }
    }

    return body
  }, [draft, dirtyFields])

  const save = useCallback(async () => {
    setSaveError(null)
    setSaveNotice(null)
    setSaving(true)
    try {
      const payload = buildPayload()
      if (Object.keys(payload).length === 0) {
        setSaving(false)
        return
      }

      const response = await requestJson<{
        saved: boolean
        reload?: { updated: string[]; added: string[]; failed: Array<{ id: string; error: string }> }
      }>('/config', jsonRequest(payload, { method: 'PUT' }))
      // The runner hot-reloads its in-memory state after every save —
      // new credentials apply to the next job without a restart.
      // Paths and cloud-mode toggles still need a restart, so we
      // hint that only when the user changed one of those.
      const pathsChanged = payload && typeof payload === 'object' && 'paths' in payload
      const cloudChanged = payload && typeof payload === 'object' && 'cloud' in payload
      const reloadFailed = (response.reload?.failed ?? []).length > 0
      if (reloadFailed) {
        const failedIds = response.reload?.failed.map(f => f.id).join(', ')
        setSaveNotice(`Configuration saved. Some plugins failed to hot-reload (${failedIds}) — restart the runner if they keep failing.`)
      } else if (pathsChanged || cloudChanged) {
        setSaveNotice('Configuration saved. Restart the runner to apply path or cloud-mode changes.')
      } else {
        setSaveNotice('Configuration saved. Changes are live for the next job — no restart needed.')
      }
      setLastSavedAt(new Date().toISOString())
      await reload()
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err)
      setSaveError(message)
    } finally {
      setSaving(false)
    }
  }, [buildPayload, reload])

  const clearSaveFeedback = useCallback(() => {
    setSaveError(null)
    setSaveNotice(null)
  }, [])

  // Beforeunload guard for unsaved changes.
  useEffect(() => {
    if (!isDirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  const markFirstRunComplete = useCallback(
    async (opts?: { skipped?: Array<'llm' | 'scm' | 'tracker'> }) => {
      setFirstRunCompleted(true)
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('coro.firstRun.completed', 'true')
      }
      // Best-effort server-side persistence so a different browser /
      // device doesn't auto-launch the wizard again.
      try {
        await requestJson(
          '/config',
          jsonRequest(
            {
              setup: {
                completedAt: new Date().toISOString(),
                ...(opts?.skipped && opts.skipped.length > 0 ? { skipped: opts.skipped } : {}),
              },
            },
            { method: 'PUT' },
          ),
        )
      } catch {
        // Older runners that don't accept `setup` simply ignore this —
        // localStorage still suppresses the auto-launch on this browser.
      }
    },
    [],
  )

  const resetFirstRun = useCallback(() => {
    setFirstRunCompleted(false)
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('coro.firstRun.completed')
    }
  }, [])

  /**
   * Commit a single FTUE step's verified config to disk. We pull the
   * latest persisted config so the patch we send doesn't accidentally
   * undo a save from another tab.
   */
  const commitWizardStep = useCallback(
    async ({
      kind,
      pluginId,
      config,
      setAsDefault,
    }: {
      kind: 'scm' | 'tracker' | 'executor'
      pluginId: string
      config: Record<string, unknown>
      setAsDefault?: boolean
    }) => {
      const current = await requestJson<ConfigResponse>('/config')
      const existing = current.config?.plugins?.installed ?? {}
      const installed: Record<string, { enabled?: boolean; config: Record<string, unknown> }> = {}
      for (const [id, entry] of Object.entries(existing)) {
        installed[id] = {
          ...(typeof entry.enabled === 'boolean' ? { enabled: entry.enabled } : {}),
          config: { ...(entry.config ?? {}) },
        }
      }
      installed[pluginId] = {
        enabled: true,
        // Merge so we don't blow away on-disk secrets the user didn't
        // re-enter this session.
        config: { ...(installed[pluginId]?.config ?? {}), ...config },
      }
      const defaults: Record<string, string> = { ...(current.config?.plugins?.defaults ?? {}) }
      if (setAsDefault) {
        if (kind === 'scm') defaults['scm'] = pluginId
        if (kind === 'tracker') defaults['tracker'] = pluginId
      }
      const payload: Record<string, unknown> = {
        plugins: { ...(Object.keys(defaults).length > 0 ? { defaults } : {}), installed },
      }
      // LLM step: also pin defaultProvider so the runner doesn't fall
      // back to a different executor at job-dispatch time.
      if (kind === 'executor') {
        payload['llm'] = {
          ...(current.config?.llm ?? {}),
          defaultProvider: pluginId,
        }
      }
      await requestJson('/config', jsonRequest(payload, { method: 'PUT' }))
      // Refresh local draft so the rest of the UI sees the new state.
      await reload()
    },
    [reload],
  )

  const value: SettingsContextValue = {
    loading,
    loadError,
    reload,
    draft,
    setDraft,
    setPluginField,
    setPluginEnabled,
    setPluginDefault,
    setGuardrailRuleEnabled,
    setGuardrailRuleConfig,
    isDirty,
    dirtyFields,
    dirtyPluginIds,
    dirtySections,
    discardChanges,
    save,
    saving,
    saveError,
    saveNotice,
    clearSaveFeedback,
    lastSavedAt,
    meta,
    preferences,
    pluginsCatalogue,
    pluginsCatalogueError,
    reloadPlugins,
    firstRunCompleted,
    markFirstRunComplete,
    resetFirstRun,
    commitWizardStep,
  }

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}
