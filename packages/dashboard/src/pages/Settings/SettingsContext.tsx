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
import { ApiError, jsonRequest, requestJson } from '../../lib/http'

// ── Persisted config shapes ─────────────────────────────────────────────────

export type AnthropicMethod = 'apiKey' | 'claudeLogin' | 'oauth'

export interface ClaudeAccountInfo {
  email?: string
  organization?: string
  subscriptionType?: string
  tokenSource?: string
  apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws'
}

export interface ClaudeLoginState {
  status: 'idle' | 'authorizing' | 'connected' | 'error'
  manualUrl?: string
  automaticUrl?: string
  account?: ClaudeAccountInfo
  error?: string
  startedAt?: string
  completedAt?: string
}

export interface McpServerEntry {
  type: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
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
  kind: 'scm' | 'tracker' | string
  version: string
  displayName: string
  hostCompatibility: string
  capabilities?: Record<string, boolean>
  configSchema: unknown
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

export interface ConfigResponse {
  config: {
    anthropic?: {
      method?: AnthropicMethod
      apiKey?: string
      oauthToken?: string
      account?: ClaudeAccountInfo
    }
    intelligence?: { dir: string; gitRemote?: string }
    paths?: { workingDir: string }
    /** Legacy single-slot git block; translated to plugin entries on load. */
    git?: {
      provider: 'github' | 'bitbucket' | 'gitlab'
      username: string
      token: string
      workspace?: string
    }
    cloud?: { url: string; token: string }
    /** Legacy single-slot tracker block; translated to plugin entries on load. */
    tracker?: {
      provider?: 'none' | 'jira' | 'github' | 'linear'
      jira?: { baseUrl?: string; username?: string; apiToken?: string }
      linear?: { apiKey?: string; teamKey?: string }
    }
    plugins?: PluginsConfigShape
    mcpServers?: Record<string, McpServerEntry>
    inheritClaudeCodeMcps?: boolean
  } | null
  configPath: string
  mode: 'hybrid' | 'local' | 'legacy'
  resolved: {
    intelligenceDir: string
    workingDir: string
  }
  configError?: string
  rawConfig?: unknown
}

// ── Draft (the unified, dirty-tracked form state) ───────────────────────────

export interface SettingsDraft {
  // LLM provider (Anthropic in v1)
  anthropicMethod: AnthropicMethod
  apiKey: string
  oauthToken: string
  // Plugins (replaces legacy single-slot git + tracker draft fields)
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
}

const EMPTY_DRAFT: SettingsDraft = {
  anthropicMethod: 'claudeLogin',
  apiKey: '',
  oauthToken: '',
  pluginInstalled: {},
  pluginDefaultScm: '',
  pluginDefaultTracker: '',
  mcpServersText: '{}',
  inheritClaudeCodeMcps: false,
  intelligenceDir: '',
  intelligenceRemote: '',
  workingDir: '',
}

// ── Section identity ────────────────────────────────────────────────────────

export type SettingsSectionId =
  | 'llm-provider'
  | 'source-control'
  | 'issue-tracker'
  | 'plugins'
  | 'mcp'
  | 'paths'

/** Static (non-plugin) field → section. Plugin entries are mapped
 * dynamically via the plugin manifest kind. */
const STATIC_FIELD_TO_SECTION: Partial<Record<keyof SettingsDraft, SettingsSectionId>> = {
  anthropicMethod: 'llm-provider',
  apiKey: 'llm-provider',
  oauthToken: 'llm-provider',
  pluginDefaultScm: 'source-control',
  pluginDefaultTracker: 'issue-tracker',
  mcpServersText: 'mcp',
  inheritClaudeCodeMcps: 'mcp',
  intelligenceDir: 'paths',
  intelligenceRemote: 'paths',
  workingDir: 'paths',
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
  // Claude login (auto-saved on the runner side, separate from draft save)
  claudeLogin: ClaudeLoginState
  claudeLoginAccount: ClaudeAccountInfo | null
  claudeLoginReady: boolean
  setClaudeLogin: (state: ClaudeLoginState) => void
  setClaudeLoginAccount: (account: ClaudeAccountInfo | null) => void
  refreshClaudeLoginStatus: () => Promise<void>
  // First run (persisted in localStorage so we don't need a backend schema change)
  firstRunCompleted: boolean
  markFirstRunComplete: () => void
  resetFirstRun: () => void
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within <SettingsProvider>')
  return ctx
}

// ── Provider ────────────────────────────────────────────────────────────────

/**
 * Translate a legacy single-slot `git` block into a synthetic plugin
 * entry so existing users see their config in the new plugin-shaped UI
 * before the runner has rewritten the file. Mirrors the runner-side
 * `legacyConfigToPlugins` translator (see `local-config.ts`).
 */
function legacyGitToPlugin(
  git: NonNullable<NonNullable<ConfigResponse['config']>['git']>,
): { id: string; entry: PluginInstalledEntry } | null {
  if (!git.username || !git.token) return null
  if (git.provider === 'github') {
    return {
      id: 'github',
      entry: {
        enabled: true,
        config: { owner: git.workspace ?? git.username, token: git.token },
      },
    }
  }
  if (git.provider === 'bitbucket') {
    return {
      id: 'bitbucket',
      entry: {
        enabled: true,
        config: {
          workspace: git.workspace ?? '',
          coderUsername: git.username,
          coderToken: git.token,
        },
      },
    }
  }
  if (git.provider === 'gitlab') {
    return {
      id: 'gitlab',
      entry: {
        enabled: true,
        config: { token: git.token, ...(git.workspace ? { workspace: git.workspace } : {}) },
      },
    }
  }
  return null
}

function legacyTrackerToPlugin(
  tracker: NonNullable<NonNullable<ConfigResponse['config']>['tracker']>,
  gitFallback?: NonNullable<ConfigResponse['config']>['git'],
): { id: string; entry: PluginInstalledEntry } | null {
  if (tracker.provider === 'jira' && tracker.jira) {
    return {
      id: 'jira',
      entry: {
        enabled: true,
        config: {
          baseUrl: tracker.jira.baseUrl ?? '',
          username: tracker.jira.username ?? '',
          apiToken: tracker.jira.apiToken ?? '',
        },
      },
    }
  }
  if (tracker.provider === 'linear' && tracker.linear) {
    return {
      id: 'linear',
      entry: {
        enabled: true,
        config: {
          apiKey: tracker.linear.apiKey ?? '',
          ...(tracker.linear.teamKey ? { teamKey: tracker.linear.teamKey } : {}),
        },
      },
    }
  }
  if (tracker.provider === 'github' && gitFallback?.token) {
    return {
      id: 'github-issues',
      entry: {
        enabled: true,
        config: {
          token: gitFallback.token,
          defaultOwner: gitFallback.workspace ?? gitFallback.username,
        },
      },
    }
  }
  return null
}

function configToDraft(response: ConfigResponse): SettingsDraft {
  const cfg = response.config
  if (!cfg) return EMPTY_DRAFT
  const mcpJson = JSON.stringify(cfg.mcpServers ?? {}, null, 2)

  // Plugins: prefer explicit `plugins.installed`; fall back to legacy
  // git/tracker translation so users coming from a pre-migration
  // config still see their credentials in the plugin cards.
  const installed: Record<string, PluginInstalledEntry> = {}
  let defaultScm = ''
  let defaultTracker = ''
  if (cfg.plugins?.installed && Object.keys(cfg.plugins.installed).length > 0) {
    for (const [id, entry] of Object.entries(cfg.plugins.installed)) {
      installed[id] = {
        ...(typeof entry.enabled === 'boolean' ? { enabled: entry.enabled } : {}),
        config: { ...(entry.config ?? {}) },
      }
    }
    defaultScm = cfg.plugins.defaults?.scm ?? ''
    defaultTracker = cfg.plugins.defaults?.tracker ?? ''
  } else {
    if (cfg.git) {
      const seeded = legacyGitToPlugin(cfg.git)
      if (seeded) installed[seeded.id] = seeded.entry
    }
    if (cfg.tracker) {
      const seeded = legacyTrackerToPlugin(cfg.tracker, cfg.git)
      if (seeded) installed[seeded.id] = seeded.entry
    }
  }

  return {
    anthropicMethod: cfg.anthropic?.method ?? 'claudeLogin',
    apiKey: cfg.anthropic?.apiKey ?? '',
    oauthToken: cfg.anthropic?.oauthToken ?? '',
    pluginInstalled: installed,
    pluginDefaultScm: defaultScm,
    pluginDefaultTracker: defaultTracker,
    mcpServersText: mcpJson,
    inheritClaudeCodeMcps: cfg.inheritClaudeCodeMcps === true,
    intelligenceDir: cfg.intelligence?.dir ?? '',
    intelligenceRemote: cfg.intelligence?.gitRemote ?? '',
    workingDir: cfg.paths?.workingDir ?? '',
  }
}

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
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const [pluginsCatalogue, setPluginsCatalogue] = useState<PluginsCatalogue | null>(null)
  const [pluginsCatalogueError, setPluginsCatalogueError] = useState<string | null>(null)

  const [claudeLogin, setClaudeLoginState] = useState<ClaudeLoginState>({ status: 'idle' })
  const [claudeLoginAccount, setClaudeLoginAccountState] = useState<ClaudeAccountInfo | null>(null)
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

      const nextDraft = configToDraft(data)
      setDraftState(nextDraft)
      setBaseline(nextDraft)

      const anthropic = data.config?.anthropic
      const account = anthropic?.account ?? null
      setClaudeLoginAccountState(account)
      setClaudeLoginState(previous => {
        if (previous.status === 'authorizing') return previous
        if (anthropic?.method === 'claudeLogin') {
          return account ? { status: 'connected', account } : { status: 'connected' }
        }
        return { status: 'idle' }
      })

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

    // Anthropic — sent only when LLM section is dirty
    if (
      dirtyFields.has('anthropicMethod') ||
      dirtyFields.has('apiKey') ||
      dirtyFields.has('oauthToken')
    ) {
      const account = claudeLogin.account ?? claudeLoginAccount
      body['anthropic'] =
        draft.anthropicMethod === 'claudeLogin'
          ? { method: 'claudeLogin' as const, account: account ?? undefined }
          : draft.anthropicMethod === 'oauth'
            ? { method: 'oauth' as const, oauthToken: draft.oauthToken }
            : { method: 'apiKey' as const, apiKey: draft.apiKey }
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

    return body
  }, [draft, dirtyFields, claudeLogin, claudeLoginAccount])

  const claudeLoginReady = claudeLogin.status === 'connected' || !!(claudeLogin.account ?? claudeLoginAccount)

  const save = useCallback(async () => {
    setSaveError(null)
    setSaveNotice(null)
    setSaving(true)
    try {
      // Validate Claude login completion before sending.
      if (
        dirtyFields.has('anthropicMethod') &&
        draft.anthropicMethod === 'claudeLogin' &&
        !claudeLoginReady
      ) {
        throw new Error('Connect Claude before saving the Claude login auth mode.')
      }

      const payload = buildPayload()
      if (Object.keys(payload).length === 0) {
        setSaving(false)
        return
      }

      await requestJson('/config', jsonRequest(payload, { method: 'PUT' }))
      setSaveNotice('Configuration saved. Restart the runner if any path or auth mode changed.')
      setLastSavedAt(new Date().toISOString())
      await reload()
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err)
      setSaveError(message)
    } finally {
      setSaving(false)
    }
  }, [dirtyFields, draft.anthropicMethod, claudeLoginReady, buildPayload, reload])

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

  // Claude login background polling (only while authorizing).
  const refreshClaudeLoginStatus = useCallback(async () => {
    try {
      const data = await requestJson<ClaudeLoginState>('/config/anthropic/claude-login/status')
      if (data.status === 'idle') return
      setClaudeLoginState(data)
      if (data.account) setClaudeLoginAccountState(data.account)
      if (data.status === 'connected') {
        setDraftState(previous => ({ ...previous, anthropicMethod: 'claudeLogin' }))
      }
    } catch {
      // Soft fail — the section will surface its own error if the user
      // explicitly tries to act.
    }
  }, [])

  useEffect(() => {
    if (claudeLogin.status !== 'authorizing') return
    const timer = window.setInterval(() => void refreshClaudeLoginStatus(), 2000)
    return () => window.clearInterval(timer)
  }, [claudeLogin.status, refreshClaudeLoginStatus])

  const setClaudeLogin = useCallback((next: ClaudeLoginState) => {
    setClaudeLoginState(next)
    if (next.account) setClaudeLoginAccountState(next.account)
  }, [])

  const setClaudeLoginAccount = useCallback((next: ClaudeAccountInfo | null) => {
    setClaudeLoginAccountState(next)
  }, [])

  const markFirstRunComplete = useCallback(() => {
    setFirstRunCompleted(true)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('coro.firstRun.completed', 'true')
    }
  }, [])

  const resetFirstRun = useCallback(() => {
    setFirstRunCompleted(false)
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem('coro.firstRun.completed')
    }
  }, [])

  const value: SettingsContextValue = {
    loading,
    loadError,
    reload,
    draft,
    setDraft,
    setPluginField,
    setPluginEnabled,
    setPluginDefault,
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
    pluginsCatalogue,
    pluginsCatalogueError,
    reloadPlugins,
    claudeLogin,
    claudeLoginAccount,
    claudeLoginReady,
    setClaudeLogin,
    setClaudeLoginAccount,
    refreshClaudeLoginStatus,
    firstRunCompleted,
    markFirstRunComplete,
    resetFirstRun,
  }

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}
