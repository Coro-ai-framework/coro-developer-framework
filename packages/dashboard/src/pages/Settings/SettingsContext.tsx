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
export type TrackerProvider = 'none' | 'jira' | 'github' | 'linear'
export type GitProvider = 'bitbucket' | 'github' | 'gitlab'

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
    git?: {
      provider: GitProvider
      username: string
      token: string
      workspace?: string
    }
    cloud?: { url: string; token: string }
    tracker?: {
      provider?: TrackerProvider
      jira?: { baseUrl?: string; username?: string; apiToken?: string }
      linear?: { apiKey?: string; teamKey?: string }
    }
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
  // Source control
  gitProvider: GitProvider
  gitUsername: string
  gitToken: string
  gitWorkspace: string
  // Tracker
  trackerProvider: TrackerProvider
  jiraBaseUrl: string
  jiraUsername: string
  jiraApiToken: string
  linearApiKey: string
  linearTeamKey: string
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
  gitProvider: 'github',
  gitUsername: '',
  gitToken: '',
  gitWorkspace: '',
  trackerProvider: 'none',
  jiraBaseUrl: '',
  jiraUsername: '',
  jiraApiToken: '',
  linearApiKey: '',
  linearTeamKey: '',
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

const FIELD_TO_SECTION: Record<keyof SettingsDraft, SettingsSectionId> = {
  anthropicMethod: 'llm-provider',
  apiKey: 'llm-provider',
  oauthToken: 'llm-provider',
  gitProvider: 'source-control',
  gitUsername: 'source-control',
  gitToken: 'source-control',
  gitWorkspace: 'source-control',
  trackerProvider: 'issue-tracker',
  jiraBaseUrl: 'issue-tracker',
  jiraUsername: 'issue-tracker',
  jiraApiToken: 'issue-tracker',
  linearApiKey: 'issue-tracker',
  linearTeamKey: 'issue-tracker',
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
  isDirty: boolean
  dirtyFields: Set<keyof SettingsDraft>
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

function configToDraft(response: ConfigResponse): SettingsDraft {
  const cfg = response.config
  if (!cfg) return EMPTY_DRAFT
  const mcpJson = JSON.stringify(cfg.mcpServers ?? {}, null, 2)
  return {
    anthropicMethod: cfg.anthropic?.method ?? 'claudeLogin',
    apiKey: cfg.anthropic?.apiKey ?? '',
    oauthToken: cfg.anthropic?.oauthToken ?? '',
    gitProvider: cfg.git?.provider ?? 'github',
    gitUsername: cfg.git?.username ?? '',
    gitToken: cfg.git?.token ?? '',
    gitWorkspace: cfg.git?.workspace ?? '',
    trackerProvider: cfg.tracker?.provider ?? 'none',
    jiraBaseUrl: cfg.tracker?.jira?.baseUrl ?? '',
    jiraUsername: cfg.tracker?.jira?.username ?? '',
    jiraApiToken: cfg.tracker?.jira?.apiToken ?? '',
    linearApiKey: cfg.tracker?.linear?.apiKey ?? '',
    linearTeamKey: cfg.tracker?.linear?.teamKey ?? '',
    mcpServersText: mcpJson,
    inheritClaudeCodeMcps: cfg.inheritClaudeCodeMcps === true,
    intelligenceDir: cfg.intelligence?.dir ?? '',
    intelligenceRemote: cfg.intelligence?.gitRemote ?? '',
    workingDir: cfg.paths?.workingDir ?? '',
  }
}

function draftEqualField<K extends keyof SettingsDraft>(a: SettingsDraft[K], b: SettingsDraft[K]): boolean {
  return a === b
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

  const [claudeLogin, setClaudeLoginState] = useState<ClaudeLoginState>({ status: 'idle' })
  const [claudeLoginAccount, setClaudeLoginAccountState] = useState<ClaudeAccountInfo | null>(null)
  const [firstRunCompleted, setFirstRunCompleted] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('coro.firstRun.completed') === 'true'
  })

  const baselineRef = useRef(baseline)
  baselineRef.current = baseline

  const reload = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await requestJson<ConfigResponse>('/config')
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
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const setDraft = useCallback(<K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) => {
    setDraftState(previous => ({ ...previous, [key]: value }))
    // Touching the draft clears stale save feedback.
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

  const dirtySections = useMemo(() => {
    const out = new Set<SettingsSectionId>()
    dirtyFields.forEach(field => out.add(FIELD_TO_SECTION[field]))
    return out
  }, [dirtyFields])

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

    // Git
    if (
      dirtyFields.has('gitProvider') ||
      dirtyFields.has('gitUsername') ||
      dirtyFields.has('gitToken') ||
      dirtyFields.has('gitWorkspace')
    ) {
      body['git'] = draft.gitUsername
        ? {
            provider: draft.gitProvider,
            username: draft.gitUsername,
            token: draft.gitToken,
            workspace: draft.gitWorkspace || undefined,
          }
        : undefined
    }

    // Tracker
    if (
      dirtyFields.has('trackerProvider') ||
      dirtyFields.has('jiraBaseUrl') ||
      dirtyFields.has('jiraUsername') ||
      dirtyFields.has('jiraApiToken') ||
      dirtyFields.has('linearApiKey') ||
      dirtyFields.has('linearTeamKey')
    ) {
      body['tracker'] =
        draft.trackerProvider === 'jira'
          ? {
              provider: 'jira' as const,
              jira: {
                baseUrl: draft.jiraBaseUrl || undefined,
                username: draft.jiraUsername || undefined,
                apiToken: draft.jiraApiToken,
              },
            }
          : draft.trackerProvider === 'linear'
            ? {
                provider: 'linear' as const,
                linear: {
                  apiKey: draft.linearApiKey,
                  teamKey: draft.linearTeamKey || undefined,
                },
              }
            : draft.trackerProvider === 'github'
              ? { provider: 'github' as const }
              : { provider: 'none' as const }
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
    isDirty,
    dirtyFields,
    dirtySections,
    discardChanges,
    save,
    saving,
    saveError,
    saveNotice,
    clearSaveFeedback,
    lastSavedAt,
    meta,
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
