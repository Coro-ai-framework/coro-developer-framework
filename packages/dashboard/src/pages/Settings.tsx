import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { GitBranch, KeyRound, PackagePlus, Plug, RefreshCcw, ShieldCheck, Ticket, Trash2, Waypoints } from 'lucide-react'
import PageHeader from '../components/common/page-header'
import StatCard from '../components/common/stat-card'
import ErrorState from '../components/common/error-state'
import Field from '../components/forms/field'
import SectionCard from '../components/forms/section-card'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { Separator } from '../components/ui/separator'
import { Skeleton } from '../components/ui/skeleton'
import { Switch } from '../components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Textarea } from '../components/ui/textarea'
import { ApiError, jsonRequest, requestJson } from '../lib/http'
import { cn } from '../lib/utils'
import { toneClasses, type Tone } from '../lib/status'

type AnthropicMethod = 'apiKey' | 'claudeLogin' | 'oauth'
type TrackerProvider = 'none' | 'jira' | 'github' | 'linear'
type SettingsTab = 'anthropic' | 'plugins' | 'mcp' | 'git' | 'tracker' | 'paths'

interface PluginManifestSummary {
  id: string
  kind: 'scm' | 'tracker' | string
  version: string
  displayName: string
  hostCompatibility: string
  capabilities?: Record<string, boolean>
  webhook?: {
    pathSuffix: string
    algorithm: string
    header: string
    format: string
  }
  configSchema: unknown
}

interface PluginMcpServerSummary {
  type: 'stdio' | 'sse' | 'http' | string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

interface PluginsResponse {
  plugins: {
    manifest: PluginManifestSummary
    installed: boolean
    configured?: boolean
    active?: boolean
    available?: boolean
    activationHint?: string
    source?: 'builtin' | 'dropin'
    mcpServer?: PluginMcpServerSummary | null
  }[]
  defaults: { scm?: string; tracker?: string }
  webhookBaseUrl: string | null
}

interface ClaudeAccountInfo {
  email?: string
  organization?: string
  subscriptionType?: string
  tokenSource?: string
  apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws'
}

interface ClaudeLoginState {
  status: 'idle' | 'authorizing' | 'connected' | 'error'
  manualUrl?: string
  automaticUrl?: string
  account?: ClaudeAccountInfo
  error?: string
  startedAt?: string
  completedAt?: string
}

interface McpServerEntry {
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

interface ConfigResponse {
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
      provider: 'bitbucket' | 'github' | 'gitlab'
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

interface SettingsForm {
  anthropicMethod: AnthropicMethod
  apiKey: string
  oauthToken: string
  intelligenceDir: string
  intelligenceRemote: string
  workingDir: string
  gitProvider: 'bitbucket' | 'github' | 'gitlab'
  gitUsername: string
  gitToken: string
  gitWorkspace: string
  trackerProvider: TrackerProvider
  jiraBaseUrl: string
  jiraUsername: string
  jiraApiToken: string
  linearApiKey: string
  linearTeamKey: string
}

interface LegacyOauthResponse {
  token?: string
  error?: string
  message?: string
  stderr?: string
  authUrl?: string | null
  requestedScopes?: string[] | null
  scopeRequestSupported?: boolean
  forcedReauth?: boolean
  limitation?: string
  recommendation?: string
}

const EMPTY_FORM: SettingsForm = {
  anthropicMethod: 'claudeLogin',
  apiKey: '',
  oauthToken: '',
  intelligenceDir: '',
  intelligenceRemote: '',
  workingDir: '',
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
}

const EMPTY_CLAUDE_LOGIN_STATE: ClaudeLoginState = { status: 'idle' }

function Notice({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <div className={cn('rounded-2xl border px-4 py-3 text-sm', toneClasses(tone))}>
      {children}
    </div>
  )
}

interface ChoiceButtonProps {
  active: boolean
  onClick: () => void
  children: ReactNode
}

function ChoiceButton({ active, onClick, children }: ChoiceButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-2xl border px-4 py-3 text-left text-sm transition-colors',
        active
          ? 'border-accent-500/35 bg-accent-500/8 text-fg'
          : 'border-line bg-overlay/40 text-fg-muted hover:border-line-strong hover:text-fg',
      )}
    >
      {children}
    </button>
  )
}

function StatusPill({ status }: { status: ClaudeLoginState['status'] }) {
  const toneMap: Record<ClaudeLoginState['status'], Tone> = {
    connected: 'success',
    authorizing: 'accent',
    error: 'danger',
    idle: 'neutral',
  }

  const labels = {
    connected: 'Connected',
    authorizing: 'Waiting for browser login',
    error: 'Needs attention',
    idle: 'Not connected',
  }

  return (
    <span
      className={cn(
        'rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em]',
        toneClasses(toneMap[status]),
      )}
    >
      {labels[status]}
    </span>
  )
}

type PluginEntry = PluginsResponse['plugins'][number]

function pluginConfigured(plugin: PluginEntry): boolean {
  return plugin.configured ?? plugin.installed
}

function pluginStatus(plugin: PluginEntry): { label: string; tone: Tone } {
  if (pluginConfigured(plugin) && plugin.active) return { label: 'enabled', tone: 'success' }
  if (pluginConfigured(plugin)) return { label: 'configured', tone: 'warning' }
  if (plugin.source === 'builtin') return { label: 'built in', tone: 'neutral' }
  return { label: 'installed', tone: 'neutral' }
}

function pluginSortValue(plugin: PluginEntry): number {
  if (pluginConfigured(plugin) && plugin.active) return 0
  if (pluginConfigured(plugin)) return 1
  if (plugin.source === 'builtin') return 2
  return 3
}

function AccountFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-overlay/40 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-[0.16em] text-fg-subtle">{label}</div>
      <div className="mt-1 text-sm text-fg">{value}</div>
    </div>
  )
}

function formatProvider(provider: ClaudeAccountInfo['apiProvider']) {
  switch (provider) {
    case 'firstParty':
      return 'Claude'
    case 'anthropicAws':
      return 'Anthropic AWS'
    case 'bedrock':
      return 'Amazon Bedrock'
    case 'vertex':
      return 'Vertex AI'
    case 'foundry':
      return 'Azure AI Foundry'
    default:
      return provider ?? 'Unknown'
  }
}

function parseClaudeCallbackInput(rawInput: string, fallbackState: string) {
  const trimmed = rawInput.trim()
  if (!trimmed) {
    throw new Error('Paste the callback URL or authorization code to complete login manually.')
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed)
    const authorizationCode = url.searchParams.get('code')
    if (!authorizationCode) {
      throw new Error('The callback URL is missing the code query parameter.')
    }

    return {
      authorizationCode,
      state: url.searchParams.get('state') ?? (fallbackState.trim() || undefined),
    }
  }

  return {
    authorizationCode: trimmed,
    state: fallbackState.trim() || undefined,
  }
}

function SettingsLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </div>
  )
}

export default function Settings() {
  const [form, setForm] = useState<SettingsForm>(EMPTY_FORM)
  const [activeTab, setActiveTab] = useState<SettingsTab>('anthropic')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [meta, setMeta] = useState<{
    configPath: string
    mode: ConfigResponse['mode']
    resolved: ConfigResponse['resolved']
    configError?: string
    rawConfig?: unknown
  } | null>(null)

  const [claudeLoginState, setClaudeLoginState] = useState<ClaudeLoginState>(EMPTY_CLAUDE_LOGIN_STATE)
  const [claudeLoginAccount, setClaudeLoginAccount] = useState<ClaudeAccountInfo | null>(null)
  const [claudeLoginConnecting, setClaudeLoginConnecting] = useState(false)
  const [claudeLoginSubmittingCallback, setClaudeLoginSubmittingCallback] = useState(false)
  const [claudeLoginCallbackInput, setClaudeLoginCallbackInput] = useState('')
  const [claudeLoginCallbackState, setClaudeLoginCallbackState] = useState('')

  const [oauthGenerating, setOauthGenerating] = useState(false)
  const [oauthCliMissing, setOauthCliMissing] = useState(false)
  const [oauthStatus, setOauthStatus] = useState<string | null>(null)
  const [oauthAuthUrl, setOauthAuthUrl] = useState<string | null>(null)

  const [pluginsState, setPluginsState] = useState<PluginsResponse | null>(null)
  const [pluginsLoading, setPluginsLoading] = useState(false)
  const [installSpec, setInstallSpec] = useState('')
  const [installId, setInstallId] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [installNotice, setInstallNotice] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  // BYO MCP servers editor (S8). Held as a JSON string so operators
  // can paste a full block in one go without us re-implementing every
  // shape variation in form controls.
  const [mcpServersText, setMcpServersText] = useState('{}')
  const [mcpServersOriginal, setMcpServersOriginal] = useState('{}')
  const [mcpSaving, setMcpSaving] = useState(false)
  const [mcpError, setMcpError] = useState<string | null>(null)
  const [mcpNotice, setMcpNotice] = useState<string | null>(null)

  // Claude Code MCP inheritance (S9).
  const [inheritClaudeCodeMcps, setInheritClaudeCodeMcps] = useState(false)
  const [inheritSaving, setInheritSaving] = useState(false)
  const [claudeCodeMcps, setClaudeCodeMcps] = useState<{
    servers: Record<string, McpServerEntry>
    sources: string[]
  } | null>(null)
  const [claudeCodeMcpsLoading, setClaudeCodeMcpsLoading] = useState(false)

  const effectiveClaudeAccount = claudeLoginState.account ?? claudeLoginAccount
  const claudeLoginReady = claudeLoginState.status === 'connected' || !!effectiveClaudeAccount
  const claudeLoginUrl = claudeLoginState.automaticUrl ?? claudeLoginState.manualUrl ?? null

  const authSummary =
    form.anthropicMethod === 'claudeLogin'
      ? claudeLoginReady
        ? 'Claude login connected'
        : 'Claude login pending'
      : form.anthropicMethod === 'apiKey'
        ? form.apiKey
          ? 'API key configured'
          : 'API key missing'
        : form.oauthToken
          ? 'Legacy token configured'
          : 'Legacy token missing'

  useEffect(() => {
    void loadConfig()
    void loadPlugins()
  }, [])

  async function loadPlugins() {
    try {
      setPluginsLoading(true)
      const data = await requestJson<PluginsResponse>('/plugins')
      setPluginsState(data)
    } catch {
      // The plugins endpoint is optional in older runners; suppress
      // the error so the rest of Settings still renders.
      setPluginsState(null)
    } finally {
      setPluginsLoading(false)
    }
  }

  async function installPlugin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setInstallError(null)
    setInstallNotice(null)
    const spec = installSpec.trim()
    if (!spec) {
      setInstallError('Enter an npm package name (e.g. `@coro/plugin-gitlab`).')
      return
    }
    try {
      setInstalling(true)
      const body: Record<string, string> = { spec }
      const id = installId.trim()
      if (id) body['id'] = id
      const result = await requestJson<{ manifest: { id: string; displayName: string }; restartHint?: string }>(
        '/plugins/install',
        jsonRequest(body, { method: 'POST' }),
      )
      setInstallNotice(
        `Installed "${result.manifest.displayName}". ${result.restartHint ?? 'Restart the runner to load it.'}`,
      )
      setInstallSpec('')
      setInstallId('')
      void loadPlugins()
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message
      setInstallError(message)
    } finally {
      setInstalling(false)
    }
  }

  async function uninstallPlugin(id: string, displayName: string) {
    setInstallError(null)
    setInstallNotice(null)
    if (!window.confirm(`Remove drop-in plugin "${displayName}"? The runner will need a restart to drop it from memory.`)) {
      return
    }
    try {
      setRemovingId(id)
      const result = await requestJson<{ restartHint?: string }>(`/plugins/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      setInstallNotice(`Removed "${displayName}". ${result.restartHint ?? 'Restart the runner to fully unload it.'}`)
      void loadPlugins()
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message
      setInstallError(`Failed to uninstall ${displayName}: ${message}`)
    } finally {
      setRemovingId(null)
    }
  }

  async function loadClaudeCodeMcps() {
    try {
      setClaudeCodeMcpsLoading(true)
      const data = await requestJson<{ servers: Record<string, McpServerEntry>; sources: string[] }>(
        '/config/claude-code-mcps',
      )
      setClaudeCodeMcps(data)
    } catch {
      setClaudeCodeMcps(null)
    } finally {
      setClaudeCodeMcpsLoading(false)
    }
  }

  async function setInheritClaudeCodeMcpsToggle(next: boolean) {
    setMcpError(null)
    setMcpNotice(null)
    try {
      setInheritSaving(true)
      await requestJson('/config', jsonRequest({ inheritClaudeCodeMcps: next }, { method: 'PUT' }))
      setInheritClaudeCodeMcps(next)
      setMcpNotice(
        next
          ? 'Inheritance enabled. New jobs will see your Claude Code MCP servers under `mcp__<id>__*` after the runner restarts.'
          : 'Inheritance disabled. Already-running jobs keep their attached servers; new jobs only see the BYO list above.',
      )
      if (next && !claudeCodeMcps) void loadClaudeCodeMcps()
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message
      setMcpError(message)
    } finally {
      setInheritSaving(false)
    }
  }

  async function saveMcpServers() {
    setMcpError(null)
    setMcpNotice(null)
    let parsed: Record<string, McpServerEntry>
    try {
      parsed = JSON.parse(mcpServersText) as Record<string, McpServerEntry>
    } catch (err) {
      setMcpError(`Invalid JSON: ${(err as Error).message}`)
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setMcpError('mcpServers must be a JSON object keyed by server id.')
      return
    }
    try {
      setMcpSaving(true)
      await requestJson('/config', jsonRequest({ mcpServers: parsed }, { method: 'PUT' }))
      const formatted = JSON.stringify(parsed, null, 2)
      setMcpServersText(formatted)
      setMcpServersOriginal(formatted)
      setMcpNotice('Saved. Restart the runner so the new servers are attached to job sessions.')
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message
      setMcpError(message)
    } finally {
      setMcpSaving(false)
    }
  }

  useEffect(() => {
    if (claudeLoginState.status !== 'authorizing') return
    const timer = window.setInterval(() => {
      void refreshClaudeLoginStatus()
    }, 2000)
    return () => {
      window.clearInterval(timer)
    }
  }, [claudeLoginState.status])

  async function loadConfig() {
    try {
      setLoading(true)
      const data = await requestJson<ConfigResponse>('/config')

      setMeta({
        configPath: data.configPath,
        mode: data.mode,
        resolved: data.resolved,
        configError: data.configError,
        rawConfig: data.rawConfig,
      })

      const anthropic = data.config?.anthropic
      const savedAccount = anthropic?.account ?? null
      setClaudeLoginAccount(savedAccount)
      setClaudeLoginState(previous => {
        if (previous.status === 'authorizing') return previous
        if (anthropic?.method === 'claudeLogin') {
          return savedAccount ? { status: 'connected', account: savedAccount } : { status: 'connected' }
        }
        return EMPTY_CLAUDE_LOGIN_STATE
      })

      if (data.config) {
        setForm({
          anthropicMethod: anthropic?.method ?? 'claudeLogin',
          apiKey: anthropic?.apiKey ?? '',
          oauthToken: anthropic?.oauthToken ?? '',
          intelligenceDir: data.config.intelligence?.dir ?? '',
          intelligenceRemote: data.config.intelligence?.gitRemote ?? '',
          workingDir: data.config.paths?.workingDir ?? '',
          gitProvider: data.config.git?.provider ?? 'github',
          gitUsername: data.config.git?.username ?? '',
          gitToken: data.config.git?.token ?? '',
          gitWorkspace: data.config.git?.workspace ?? '',
          trackerProvider: data.config.tracker?.provider ?? 'none',
          jiraBaseUrl: data.config.tracker?.jira?.baseUrl ?? '',
          jiraUsername: data.config.tracker?.jira?.username ?? '',
          jiraApiToken: data.config.tracker?.jira?.apiToken ?? '',
          linearApiKey: data.config.tracker?.linear?.apiKey ?? '',
          linearTeamKey: data.config.tracker?.linear?.teamKey ?? '',
        })
        const mcpJson = JSON.stringify(data.config.mcpServers ?? {}, null, 2)
        setMcpServersText(mcpJson)
        setMcpServersOriginal(mcpJson)
        setInheritClaudeCodeMcps(data.config.inheritClaudeCodeMcps === true)
      }
    } catch (loadIssue) {
      setError(loadIssue instanceof Error ? loadIssue.message : String(loadIssue))
    } finally {
      setLoading(false)
    }
  }

  async function refreshClaudeLoginStatus() {
    try {
      const data = await requestJson<ClaudeLoginState>('/config/anthropic/claude-login/status')
      if (data.status === 'idle') return

      setClaudeLoginState(data)
      if (data.account) setClaudeLoginAccount(data.account)

      if (data.status === 'connected') {
        setForm(previous => ({ ...previous, anthropicMethod: 'claudeLogin' }))
        setSuccess("Claude account connected. The runner will use Claude Code's local login session, including MCP permissions.")
        setError(null)
        setClaudeLoginCallbackInput('')
        setClaudeLoginCallbackState('')
      } else if (data.status === 'error') {
        setError(data.error ?? 'Claude login failed.')
      }
    } catch (refreshIssue) {
      setError(refreshIssue instanceof Error ? refreshIssue.message : String(refreshIssue))
    }
  }

  function handleChange(event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setForm(previous => ({ ...previous, [event.target.name]: event.target.value }))
    setSuccess(null)
  }

  function setAnthropicMethod(method: AnthropicMethod) {
    setForm(previous => ({ ...previous, anthropicMethod: method }))
    setSuccess(null)
    setOauthStatus(null)
    setOauthAuthUrl(null)
  }

  async function handleStartClaudeLogin() {
    setClaudeLoginConnecting(true)
    setError(null)
    setSuccess(null)

    try {
      const data = await requestJson<ClaudeLoginState>('/config/anthropic/claude-login/start', { method: 'POST' })
      setClaudeLoginState(data)
      if (data.account) setClaudeLoginAccount(data.account)

      setForm(previous => ({ ...previous, anthropicMethod: 'claudeLogin' }))

      if (data.status === 'connected') {
        setSuccess("Claude account connected. Configuration was updated to use Claude Code's local session.")
        return
      }

      if (data.status === 'authorizing') {
        if (data.automaticUrl || data.manualUrl) {
          const opened = window.open(data.automaticUrl ?? data.manualUrl, '_blank', 'noopener,noreferrer')
          setSuccess(
            opened
              ? 'Claude login started. Finish the sign-in flow in the opened browser window.'
              : 'Claude login started. Use the sign-in link below if your browser blocked the popup.',
          )
        } else {
          setSuccess('Claude login started. Finish the sign-in flow in your browser.')
        }
        return
      }

      if (data.status === 'error') {
        throw new Error(data.error ?? 'Claude login failed to start.')
      }
    } catch (loginIssue) {
      setError(loginIssue instanceof Error ? loginIssue.message : String(loginIssue))
    } finally {
      setClaudeLoginConnecting(false)
    }
  }

  async function handleSubmitClaudeLoginCallback() {
    setClaudeLoginSubmittingCallback(true)
    setError(null)
    setSuccess(null)

    try {
      const callback = parseClaudeCallbackInput(claudeLoginCallbackInput, claudeLoginCallbackState)
      const data = await requestJson<ClaudeLoginState>(
        '/config/anthropic/claude-login/callback',
        jsonRequest(callback, { method: 'POST' }),
      )

      setClaudeLoginState(data)
      if (data.account) setClaudeLoginAccount(data.account)

      if (data.status !== 'connected') {
        throw new Error(data.error ?? 'Claude login did not complete.')
      }

      setForm(previous => ({ ...previous, anthropicMethod: 'claudeLogin' }))
      setClaudeLoginCallbackInput('')
      setClaudeLoginCallbackState('')
      setSuccess("Claude account connected. Configuration was updated to use Claude Code's local session.")
    } catch (callbackIssue) {
      setError(callbackIssue instanceof Error ? callbackIssue.message : String(callbackIssue))
    } finally {
      setClaudeLoginSubmittingCallback(false)
    }
  }

  async function handleGenerateOauthToken() {
    setOauthGenerating(true)
    setOauthStatus(
      'Launching Claude Code login. Complete the sign-in in your browser; the legacy token will be filled in automatically if the CLI can extract it.',
    )
    setOauthAuthUrl(null)
    setError(null)

    try {
      const data = await requestJson<LegacyOauthResponse>('/config/anthropic/generate-oauth-token', { method: 'POST' })
      if (data.authUrl) setOauthAuthUrl(data.authUrl)

      if (data.token) {
        const token = data.token
        const looksValid = /^sk-ant-oat\d+-/.test(token) || /^sk-ant-/.test(token)
        const scopeMessage = data.scopeRequestSupported
          ? data.requestedScopes?.length
            ? ` Requested scopes: ${data.requestedScopes.join(', ')}.`
            : ''
          : ' Your installed Claude CLI did not expose scope flags, so token scopes were not explicitly requested.'
        const reauthMessage = data.forcedReauth ? ' Forced re-auth was requested to avoid cached older-scope tokens.' : ''
        const limitationMessage = data.limitation ? ` ${data.limitation}` : ''
        const recommendationMessage = data.recommendation ? ` ${data.recommendation}` : ''

        setForm(previous => ({ ...previous, oauthToken: token, anthropicMethod: 'oauth' }))
        setOauthStatus(
          looksValid
            ? `Token generated (${token.slice(0, 16)}…).${scopeMessage}${reauthMessage}${limitationMessage}${recommendationMessage} Click Save to persist it.`
            : `Captured value does not look like an Anthropic OAuth token (got "${token.slice(0, 24)}…").${scopeMessage}${reauthMessage}${limitationMessage}${recommendationMessage} Regenerate or paste a token manually.`,
        )
        setOauthAuthUrl(null)
      } else {
        setError('Token generation returned no token.')
        setOauthStatus(null)
      }
    } catch (oauthIssue) {
      if (oauthIssue instanceof ApiError) {
        const payload = oauthIssue.payload as LegacyOauthResponse | null
        if (payload?.authUrl) setOauthAuthUrl(payload.authUrl)

        if (payload?.error === 'CLI_NOT_FOUND') {
          setOauthCliMissing(true)
          setError(payload.message ?? 'Could not find a Claude Code CLI on the runner host. Reinstall the runner or paste a token generated elsewhere.')
        } else if (payload?.error === 'IN_PROGRESS') {
          setError('Another token setup is already running on this runner.')
        } else if (payload?.error === 'TIMEOUT') {
          setError(
            payload.authUrl
              ? 'Token setup timed out. If a browser did not open automatically, use the sign-in link below and try again.'
              : 'Token setup timed out after 120 seconds. Try again.',
          )
        } else if (payload?.error === 'NO_CONTROLLING_TTY') {
          setError(payload.message ?? 'The runner has no controlling terminal. Start the runner from a terminal and retry, or paste a token manually.')
        } else if (payload?.error === 'PLATFORM_UNSUPPORTED') {
          setOauthCliMissing(true)
          setError(payload.message ?? 'Automatic token generation is only supported on macOS and Linux. Run `claude setup-token` in a terminal and paste the token below.')
        } else {
          setError(payload?.message ?? payload?.stderr ?? oauthIssue.message)
        }
      } else {
        setError(oauthIssue instanceof Error ? oauthIssue.message : String(oauthIssue))
      }

      setOauthStatus(null)
    } finally {
      setOauthGenerating(false)
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSuccess(null)
    setSaving(true)

    try {
      if (form.anthropicMethod === 'claudeLogin' && !claudeLoginReady) {
        throw new Error('Connect Claude before saving the Claude login auth mode.')
      }

      const anthropic =
        form.anthropicMethod === 'claudeLogin'
          ? { method: 'claudeLogin' as const, account: effectiveClaudeAccount ?? undefined }
          : form.anthropicMethod === 'oauth'
            ? { method: 'oauth' as const, oauthToken: form.oauthToken }
            : { method: 'apiKey' as const, apiKey: form.apiKey }

      const tracker =
        form.trackerProvider === 'jira'
          ? {
              provider: 'jira' as const,
              jira: {
                baseUrl: form.jiraBaseUrl || undefined,
                username: form.jiraUsername || undefined,
                apiToken: form.jiraApiToken,
              },
            }
          : form.trackerProvider === 'linear'
            ? {
                provider: 'linear' as const,
                linear: {
                  apiKey: form.linearApiKey,
                  teamKey: form.linearTeamKey || undefined,
                },
              }
            : form.trackerProvider === 'github'
              ? { provider: 'github' as const }
              : { provider: 'none' as const }

      const body: Record<string, unknown> = {
        anthropic,
        intelligence: {
          dir: form.intelligenceDir || undefined,
          gitRemote: form.intelligenceRemote || undefined,
        },
        paths: {
          workingDir: form.workingDir || undefined,
        },
        git: form.gitUsername
          ? {
              provider: form.gitProvider,
              username: form.gitUsername,
              token: form.gitToken,
              workspace: form.gitWorkspace || undefined,
            }
          : undefined,
        tracker,
      }

      await requestJson('/config', jsonRequest(body, { method: 'PUT' }))
      setSuccess(
        form.anthropicMethod === 'claudeLogin'
          ? "Configuration saved. The runner will use Claude Code's local login session."
          : 'Configuration saved. Restart the runner for changes to take effect.',
      )
      await loadConfig()
    } catch (saveIssue) {
      setError(saveIssue instanceof Error ? saveIssue.message : String(saveIssue))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <SettingsLoading />
  }

  const authStatCardTone: Tone =
    form.anthropicMethod === 'claudeLogin' && claudeLoginReady
      ? 'success'
      : form.anthropicMethod === 'apiKey' && form.apiKey
        ? 'success'
        : form.anthropicMethod === 'oauth' && form.oauthToken
          ? 'success'
          : 'warning'

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Manage auth, git, trackers, and runner paths."
        actions={
          <Button variant="outline" onClick={() => void loadConfig()}>
            <RefreshCcw />
            Reload config
          </Button>
        }
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Mode"
          value={meta?.mode ?? '—'}
          description="Current runner operating mode."
          icon={Waypoints}
          tone={meta?.mode === 'hybrid' ? 'accent' : meta?.mode === 'local' ? 'success' : 'warning'}
        />
        <StatCard
          label="Auth"
          value={authSummary}
          description="Active Anthropic authentication strategy."
          icon={ShieldCheck}
          tone={authStatCardTone}
        />
        <StatCard
          label="Git"
          value={form.gitProvider}
          description={
            form.gitUsername
              ? `Configured for ${form.gitUsername}.`
              : 'Credentials not configured yet.'
          }
          icon={GitBranch}
          tone={form.gitUsername ? 'success' : 'warning'}
        />
        <StatCard
          label="Tracker"
          value={form.trackerProvider === 'none' ? 'Disabled' : form.trackerProvider}
          description="Campaign issue creation provider."
          icon={Ticket}
          tone={form.trackerProvider === 'none' ? 'neutral' : 'accent'}
        />
      </div>

      {meta?.configError ? (
        <Notice tone="warning">
          The current config file failed schema validation. Save the form once to rewrite it into the
          current format.
          {meta.rawConfig ? (
            <details className="mt-3 overflow-hidden rounded-xl border border-warning-500/20 bg-canvas/50">
              <summary className="cursor-pointer px-3 py-2 text-xs uppercase tracking-[0.16em] text-fg-subtle">
                View raw config
              </summary>
              <Separator />
              <pre className="max-h-64 overflow-auto p-3 text-xs whitespace-pre-wrap break-words text-fg-muted">
                {JSON.stringify(meta.rawConfig, null, 2)}
              </pre>
            </details>
          ) : null}
        </Notice>
      ) : null}

      {error ? <ErrorState message={error} /> : null}
      {success ? <Notice tone="success">{success}</Notice> : null}

      <form onSubmit={handleSubmit} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <Tabs
            value={activeTab}
            onValueChange={value => setActiveTab(value as SettingsTab)}
            className="space-y-6"
          >
            <TabsList>
              <TabsTrigger value="anthropic">Anthropic</TabsTrigger>
              <TabsTrigger value="plugins">Plugins</TabsTrigger>
              <TabsTrigger value="mcp">MCP servers</TabsTrigger>
              <TabsTrigger value="git">Git</TabsTrigger>
              <TabsTrigger value="tracker">Tracker</TabsTrigger>
              <TabsTrigger value="paths">Paths</TabsTrigger>
            </TabsList>

            <TabsContent value="anthropic" className="space-y-6">
              <SectionCard
                title="Authentication method"
                description="Pick the authentication strategy the runner should use for model access."
              >
                <div className="grid gap-3 md:grid-cols-3">
                  <ChoiceButton
                    active={form.anthropicMethod === 'claudeLogin'}
                    onClick={() => setAnthropicMethod('claudeLogin')}
                  >
                    <div className="font-medium text-fg">Claude login</div>
                    <div className="mt-1 text-fg-muted">
                      Uses Claude Code's local session and preserves MCP-capable auth context.
                    </div>
                  </ChoiceButton>
                  <ChoiceButton
                    active={form.anthropicMethod === 'apiKey'}
                    onClick={() => setAnthropicMethod('apiKey')}
                  >
                    <div className="font-medium text-fg">API key</div>
                    <div className="mt-1 text-fg-muted">
                      Best for direct Anthropic billing with explicit service credentials.
                    </div>
                  </ChoiceButton>
                  <ChoiceButton
                    active={form.anthropicMethod === 'oauth'}
                    onClick={() => setAnthropicMethod('oauth')}
                  >
                    <div className="font-medium text-fg">Legacy OAuth token</div>
                    <div className="mt-1 text-fg-muted">
                      Fallback only. Stores a raw token without session refresh.
                    </div>
                  </ChoiceButton>
                </div>
              </SectionCard>

              {form.anthropicMethod === 'claudeLogin' ? (
                <SectionCard
                  title="Claude login"
                  description="Recommended. Connect the runner to Claude Code's local login session instead of storing a separate token."
                  action={
                    <Button
                      type="button"
                      onClick={() => void handleStartClaudeLogin()}
                      disabled={claudeLoginConnecting}
                      size="sm"
                    >
                      {claudeLoginConnecting
                        ? 'Starting…'
                        : claudeLoginReady
                          ? 'Reconnect'
                          : 'Connect Claude'}
                    </Button>
                  }
                >
                  <div className="space-y-5">
                    <div className="flex flex-wrap items-center gap-3">
                      <StatusPill status={claudeLoginState.status} />
                      {effectiveClaudeAccount?.email ? (
                        <div className="text-sm text-fg-muted">{effectiveClaudeAccount.email}</div>
                      ) : null}
                    </div>

                    <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-sm text-fg-muted">
                      Uses Claude Code's own local login session, including MCP permissions and session
                      refresh. No copy-pasted token is stored in Coro.
                    </div>

                    {effectiveClaudeAccount ? (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <AccountFact label="Provider" value={formatProvider(effectiveClaudeAccount.apiProvider)} />
                        <AccountFact label="Organization" value={effectiveClaudeAccount.organization ?? 'Not reported'} />
                        <AccountFact label="Plan" value={effectiveClaudeAccount.subscriptionType ?? 'Not reported'} />
                        <AccountFact label="Token source" value={effectiveClaudeAccount.tokenSource ?? 'Not reported'} />
                      </div>
                    ) : null}

                    {claudeLoginState.status === 'authorizing' ? (
                      <div className="space-y-4">
                        <Notice tone="warning">
                          The runner is waiting for the Claude browser login to finish. This page polls
                          for completion automatically.
                        </Notice>

                        {claudeLoginUrl ? (
                          <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-sm text-fg-muted">
                            <div>If the browser did not open automatically, continue the sign-in flow here:</div>
                            <a
                              href={claudeLoginUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-2 block break-all text-accent-300 hover:text-accent-400"
                            >
                              {claudeLoginUrl}
                            </a>
                          </div>
                        ) : null}

                        <div className="grid gap-4 rounded-2xl border border-line bg-overlay/40 p-4">
                          <Field
                            label="Callback URL or authorization code"
                            hint="Use this only if automatic completion fails. Pasting the full redirected URL is preferred because it includes the OAuth state value."
                          >
                            <Input
                              value={claudeLoginCallbackInput}
                              onChange={event => setClaudeLoginCallbackInput(event.target.value)}
                              placeholder="Paste the redirected URL or the code parameter"
                            />
                          </Field>

                          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                            <Field
                              label="State override"
                              hint="Optional if you pasted a raw authorization code."
                            >
                              <Input
                                value={claudeLoginCallbackState}
                                onChange={event => setClaudeLoginCallbackState(event.target.value)}
                                placeholder="Optional state"
                              />
                            </Field>
                            <Button
                              type="button"
                              variant="secondary"
                              onClick={() => void handleSubmitClaudeLoginCallback()}
                              disabled={claudeLoginSubmittingCallback}
                            >
                              {claudeLoginSubmittingCallback ? 'Completing…' : 'Complete manually'}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </SectionCard>
              ) : null}

              {form.anthropicMethod === 'apiKey' ? (
                <SectionCard
                  title="Anthropic API key"
                  description="Use a first-party Anthropic API key billed per token."
                >
                  <Field label="API key" required hint="Anthropic API key from console.anthropic.com.">
                    <Input
                      name="apiKey"
                      type="password"
                      value={form.apiKey}
                      onChange={handleChange}
                      placeholder="sk-ant-…"
                    />
                  </Field>
                </SectionCard>
              ) : null}

              {form.anthropicMethod === 'oauth' ? (
                <SectionCard
                  title="Legacy OAuth token"
                  description="Fallback only. This does not preserve Claude Code's richer local session state."
                >
                  <div className="space-y-4">
                    <Field
                      label="OAuth token"
                      required
                      hint="Legacy fallback only. Prefer Claude login whenever possible."
                    >
                      <Input
                        name="oauthToken"
                        type="password"
                        value={form.oauthToken}
                        onChange={handleChange}
                        placeholder="sk-ant-oat01-…"
                      />
                    </Field>

                    {!oauthCliMissing ? (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => void handleGenerateOauthToken()}
                        disabled={oauthGenerating}
                        size="sm"
                      >
                        <KeyRound />
                        {oauthGenerating ? 'Generating…' : 'Generate via claude setup-token'}
                      </Button>
                    ) : null}

                    {oauthStatus ? <Notice tone="success">{oauthStatus}</Notice> : null}
                    {oauthAuthUrl ? (
                      <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-sm text-fg-muted">
                        <div>If the browser did not open automatically, sign in here:</div>
                        <a
                          href={oauthAuthUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-2 block break-all text-accent-300 hover:text-accent-400"
                        >
                          {oauthAuthUrl}
                        </a>
                      </div>
                    ) : null}
                  </div>
                </SectionCard>
              ) : null}
            </TabsContent>

            <TabsContent value="plugins" className="space-y-6">
              <SectionCard
                title="Install a plugin"
                description="Drop-in plugins live under ~/.coro/plugins/. Paste any npm package name or git/tarball spec — the runner installs it locally and merges it into the registry on the next restart."
              >
                <form onSubmit={installPlugin} className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
                    <Field
                      label="npm spec"
                      htmlFor="plugin-install-spec"
                      hint="Coro ships with built-in provider plugins. Configure credentials in the Git and Tracker tabs to enable them, or install optional drop-ins here. Defaults below decide which enabled plugin a job uses when its params don't pin one."
                    >
                      <Input
                        id="plugin-install-spec"
                        value={installSpec}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => setInstallSpec(e.target.value)}
                        placeholder="@coro/plugin-gitlab"
                        disabled={installing}
                      />
                    </Field>
                    <Field label="Plugin id (optional)" htmlFor="plugin-install-id">
                      <Input
                        id="plugin-install-id"
                        value={installId}
                        onChange={(e: ChangeEvent<HTMLInputElement>) => setInstallId(e.target.value)}
                        placeholder="gitlab"
                        disabled={installing}
                      />
                    </Field>
                    <Button type="submit" disabled={installing || !installSpec.trim()}>
                      <PackagePlus />
                      {installing ? 'Installing…' : 'Install'}
                    </Button>
                  </div>
                  {installError ? <Notice tone="danger">{installError}</Notice> : null}
                  {installNotice ? (
                    <div className="rounded-2xl border border-success/40 bg-success/10 px-4 py-3 text-sm text-success">
                      {installNotice}
                    </div>
                  ) : null}
                  <Notice tone="neutral">
                    GitLab is not built in. Install a GitLab-compatible drop-in plugin here if you need GitLab SCM.
                  </Notice>
                  <p className="text-[12px] text-fg-muted">
                    Examples: <code>@coro/plugin-gitlab</code>, <code>coro-plugin-jenkins@1.2.0</code>,{' '}
                    <code>github:my-org/coro-plugin-acme</code>. Restart the runner after installing so the new
                    plugin is loaded into the active registry.
                  </p>
                </form>
              </SectionCard>

              <SectionCard
                title="Installed plugins"
                description="Provider integrations the runner has loaded. Each plugin contributes its own MCP tools, webhook normaliser, and (optionally) intelligence snippets. Defaults below decide which plugin a job uses when its params don't pin one."
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void loadPlugins()}
                    disabled={pluginsLoading}
                  >
                    <RefreshCcw />
                    {pluginsLoading ? 'Refreshing…' : 'Refresh'}
                  </Button>
                }
              >
                {pluginsState ? (
                  <div className="space-y-5">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5">
                        <div className="text-[11px] uppercase tracking-[0.16em] text-fg-subtle">Default SCM</div>
                        <div className="mt-1 text-sm text-fg">{pluginsState.defaults.scm ?? '— (single enabled plugin wins)'}</div>
                      </div>
                      <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5">
                        <div className="text-[11px] uppercase tracking-[0.16em] text-fg-subtle">Default tracker</div>
                        <div className="mt-1 text-sm text-fg">{pluginsState.defaults.tracker ?? '— (single enabled plugin wins)'}</div>
                      </div>
                    </div>

                    {pluginsState.plugins.some(plugin => pluginConfigured(plugin) && plugin.active) ? null : (
                      <Notice tone="warning">
                        No plugins are enabled yet. Coro already ships with GitHub, Bitbucket, Jira, Linear, and
                        GitHub Issues. Configure credentials in the Git or Tracker tabs, then restart the runner.
                      </Notice>
                    )}

                    {pluginsState.plugins.length === 0 ? (
                      <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-sm text-fg-muted">
                        No plugins discovered. Configure credentials under the Git or Tracker tabs and the runner
                        will expose the matching built-ins automatically. For a forward-looking config, add a
                        <code>plugins</code> block to <code>~/.coro/config.json</code>.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {[...pluginsState.plugins]
                          .sort((left, right) => {
                            const bucket = pluginSortValue(left) - pluginSortValue(right)
                            if (bucket !== 0) return bucket
                            return left.manifest.displayName.localeCompare(right.manifest.displayName)
                          })
                          .map(plugin => {
                            const { manifest, source, mcpServer, activationHint } = plugin
                            const status = pluginStatus(plugin)
                            return (
                              <div
                                key={manifest.id}
                                className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <Plug className="size-4 text-fg-subtle" />
                                      <div className="text-[15px] font-medium text-fg">{manifest.displayName}</div>
                                      <span className="font-mono text-[11px] text-fg-subtle">{manifest.id}</span>
                                      {source === 'dropin' ? (
                                        <span className="rounded-full border border-line bg-overlay/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-fg-muted">
                                          drop-in
                                        </span>
                                      ) : null}
                                    </div>
                                    <div className="mt-1 text-[12px] text-fg-muted">
                                      kind: <span className="font-mono text-fg">{manifest.kind}</span>
                                      {' · '}
                                      v{manifest.version}
                                      {' · '}
                                      host {manifest.hostCompatibility}
                                    </div>
                                    {manifest.webhook ? (
                                      <div className="mt-2 text-[11px] text-fg-muted">
                                        Webhook: <span className="font-mono">{manifest.webhook.algorithm}</span>
                                        {' via '}
                                        <span className="font-mono">{manifest.webhook.header}</span>
                                        {pluginsState.webhookBaseUrl ? (
                                          <>
                                            {' · '}
                                            <span className="font-mono break-all">
                                              {pluginsState.webhookBaseUrl}/&lt;teamId&gt;/{manifest.id}
                                            </span>
                                          </>
                                        ) : null}
                                      </div>
                                    ) : null}
                                    {mcpServer ? (
                                      <div className="mt-2 text-[11px] text-fg-muted">
                                        Attached MCP server: <span className="font-mono">{mcpServer.type}</span>
                                        {mcpServer.type === 'stdio' && mcpServer.command ? (
                                          <>
                                            {' · '}
                                            <span className="font-mono break-all">
                                              {mcpServer.command}
                                              {mcpServer.args && mcpServer.args.length > 0
                                                ? ' ' + mcpServer.args.join(' ')
                                                : ''}
                                            </span>
                                          </>
                                        ) : null}
                                        {(mcpServer.type === 'http' || mcpServer.type === 'sse') && mcpServer.url ? (
                                          <>
                                            {' · '}
                                            <span className="font-mono break-all">{mcpServer.url}</span>
                                          </>
                                        ) : null}
                                        {' · agents see tools as '}
                                        <span className="font-mono">mcp__{manifest.id}__*</span>
                                      </div>
                                    ) : null}
                                    {!pluginConfigured(plugin) && activationHint ? (
                                      <div className="mt-2 text-[12px] leading-5 text-fg-muted">{activationHint}</div>
                                    ) : null}
                                    {pluginConfigured(plugin) && !plugin.active ? (
                                      <div className="mt-2 text-[12px] leading-5 text-warning-300">
                                        Configured, but not active in the current runner process. Recheck the provider
                                        settings and restart the runner.
                                      </div>
                                    ) : null}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span
                                      className={cn(
                                        'rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em]',
                                        toneClasses(status.tone),
                                      )}
                                    >
                                      {status.label}
                                    </span>
                                    {source === 'dropin' ? (
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => void uninstallPlugin(manifest.id, manifest.displayName)}
                                        disabled={removingId === manifest.id}
                                      >
                                        <Trash2 />
                                        {removingId === manifest.id ? 'Removing…' : 'Uninstall'}
                                      </Button>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-sm text-fg-muted">
                    {pluginsLoading
                      ? 'Loading plugins…'
                      : 'Plugin discovery is unavailable. The runner may be too old or returned an error.'}
                  </div>
                )}
              </SectionCard>
            </TabsContent>

            <TabsContent value="mcp" className="space-y-6">
              <SectionCard
                title="Bring-your-own MCP servers"
                description="Attach any MCP server (Slack, Sentry, Datadog, internal tooling, …) to every job session without writing a Coro plugin. The runner spawns each entry alongside the in-process `coro` server and the active plugin servers; agents see them as `mcp__<id>__*`."
              >
                <div className="space-y-3">
                  <Textarea
                    value={mcpServersText}
                    onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setMcpServersText(e.target.value)}
                    spellCheck={false}
                    rows={14}
                    className="font-mono text-[12px]"
                    disabled={mcpSaving}
                  />
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[12px] text-fg-muted">
                      The reserved id <code>coro</code> is rejected. Use <code>"enabled": false</code> to
                      keep an entry without attaching it. <code>allowedTools</code> /{' '}
                      <code>disallowedTools</code> are translated into the SDK's per-server tool policy.
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setMcpServersText(mcpServersOriginal)}
                        disabled={mcpSaving || mcpServersText === mcpServersOriginal}
                      >
                        Discard
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void saveMcpServers()}
                        disabled={mcpSaving}
                      >
                        {mcpSaving ? 'Saving…' : 'Save'}
                      </Button>
                    </div>
                  </div>
                  {mcpError ? (
                    <div className="rounded-2xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
                      {mcpError}
                    </div>
                  ) : null}
                  {mcpNotice ? (
                    <div className="rounded-2xl border border-success/40 bg-success/10 px-4 py-3 text-sm text-success">
                      {mcpNotice}
                    </div>
                  ) : null}
                </div>
              </SectionCard>

              <SectionCard
                title="Inherit from Claude Code"
                description="When enabled, the runner reads MCP servers from your user-level Claude Code config (~/.claude.json and ~/.claude/settings.json) and attaches them to every job session. Explicit BYO entries above override inherited entries with the same id."
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void loadClaudeCodeMcps()}
                    disabled={claudeCodeMcpsLoading}
                  >
                    <RefreshCcw />
                    {claudeCodeMcpsLoading ? 'Refreshing…' : 'Refresh'}
                  </Button>
                }
              >
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-overlay/40 px-4 py-3.5">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-fg">Inherit Claude Code MCP servers</div>
                      <div className="text-[12px] text-fg-muted">
                        Off by default — Claude Code configs commonly carry developer-personal entries
                        (Notion, GitHub Personal, …) that an operator may not want every job to see.
                      </div>
                    </div>
                    <Switch
                      checked={inheritClaudeCodeMcps}
                      onCheckedChange={(next) => void setInheritClaudeCodeMcpsToggle(next)}
                      disabled={inheritSaving}
                      ariaLabel="Inherit Claude Code MCP servers"
                    />
                  </div>

                  {claudeCodeMcps ? (
                    <div className="space-y-3">
                      {claudeCodeMcps.sources.length > 0 ? (
                        <div className="text-[12px] text-fg-muted">
                          Read from{' '}
                          {claudeCodeMcps.sources.map((src, i) => (
                            <span key={src} className="font-mono">
                              {i > 0 ? ', ' : ''}
                              {src}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-sm text-fg-muted">
                          No Claude Code MCP servers found. Add one with{' '}
                          <code>claude mcp add &lt;name&gt; --scope user</code> or paste an entry into{' '}
                          <code>~/.claude.json</code> under <code>mcpServers</code>.
                        </div>
                      )}
                      {Object.keys(claudeCodeMcps.servers).length > 0 ? (
                        <pre className="overflow-auto rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-[12px] text-fg-muted">
                          {JSON.stringify(claudeCodeMcps.servers, null, 2)}
                        </pre>
                      ) : null}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-sm text-fg-muted">
                      {claudeCodeMcpsLoading
                        ? 'Loading discovered servers…'
                        : 'Click Refresh to preview the MCP servers Claude Code currently exposes.'}
                    </div>
                  )}
                </div>
              </SectionCard>

              <SectionCard
                title="Examples"
                description="Drop these into the editor above. Replace the placeholder secrets with real ones — values containing `...` are treated as redacted echoes and ignored on save."
              >
                <pre className="overflow-auto rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-[12px] text-fg-muted">
{`{
  "slack": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-slack"],
    "env": { "SLACK_BOT_TOKEN": "xoxb-…" },
    "allowedTools": ["list_channels", "search_messages"]
  },
  "sentry": {
    "type": "http",
    "url": "https://mcp.sentry.io",
    "headers": { "Authorization": "Bearer …" }
  },
  "datadog": {
    "type": "sse",
    "url": "https://mcp.datadoghq.com/sse",
    "enabled": false
  }
}`}
                </pre>
              </SectionCard>
            </TabsContent>

            <TabsContent value="git" className="space-y-6">
              <SectionCard
                title="Git provider"
                description="Credentials used for clone, branch, PR, and review operations."
              >
                <div className="space-y-4">
                  <Field label="Provider">
                    <Select name="gitProvider" value={form.gitProvider} onChange={handleChange}>
                      <option value="github">GitHub</option>
                      <option value="bitbucket">Bitbucket</option>
                      <option value="gitlab">GitLab</option>
                    </Select>
                  </Field>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Username" hint="The account used to authenticate with the git provider.">
                      <Input
                        name="gitUsername"
                        value={form.gitUsername}
                        onChange={handleChange}
                        placeholder="your-username"
                      />
                    </Field>
                    <Field
                      label={form.gitProvider === 'github' ? 'Personal access token' : 'App password'}
                      hint="Stored in the local runner config file."
                    >
                      <Input
                        name="gitToken"
                        type="password"
                        value={form.gitToken}
                        onChange={handleChange}
                        placeholder={form.gitProvider === 'github' ? 'ghp_…' : 'Token'}
                      />
                    </Field>
                  </div>

                  <Field
                    label={form.gitProvider === 'bitbucket' ? 'Workspace slug' : 'Organization / owner'}
                    hint={
                      form.gitProvider === 'bitbucket'
                        ? 'Required to enable the built-in Bitbucket plugin and for PR APIs.'
                        : form.gitProvider === 'github'
                          ? 'Required to enable the built-in GitHub plugin and for repo/PR APIs.'
                          : 'Used by GitLab-compatible drop-in plugins. GitLab is not built in.'
                    }
                  >
                    <Input
                      name="gitWorkspace"
                      value={form.gitWorkspace}
                      onChange={handleChange}
                      placeholder={form.gitProvider === 'bitbucket' ? 'my-workspace' : 'my-org'}
                    />
                  </Field>

                  {form.gitProvider === 'gitlab' ? (
                    <Notice tone="warning">
                      GitLab is not a built-in Coro plugin. Install a GitLab-compatible drop-in plugin from the
                      Plugins tab before using GitLab for jobs.
                    </Notice>
                  ) : null}
                </div>
              </SectionCard>
            </TabsContent>

            <TabsContent value="tracker" className="space-y-6">
              <SectionCard
                title="Issue tracker"
                description="Used by campaigns when they need to create an epic and child issues."
              >
                <div className="space-y-5">
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {(['none', 'jira', 'github', 'linear'] as TrackerProvider[]).map(provider => (
                      <ChoiceButton
                        key={provider}
                        active={form.trackerProvider === provider}
                        onClick={() => {
                          setForm(previous => ({ ...previous, trackerProvider: provider }))
                          setSuccess(null)
                        }}
                      >
                        <div className="font-medium text-fg">
                          {provider === 'none'
                            ? 'None'
                            : provider === 'github'
                              ? 'GitHub Issues'
                              : provider.charAt(0).toUpperCase() + provider.slice(1)}
                        </div>
                        <div className="mt-1 text-fg-muted">
                          {provider === 'none'
                            ? 'Run campaigns without tracker round-trips.'
                            : provider === 'jira'
                              ? 'Create issues through Jira.'
                              : provider === 'github'
                                ? 'Reuse GitHub credentials for issue creation.'
                                : 'Create issues through Linear.'}
                        </div>
                      </ChoiceButton>
                    ))}
                  </div>

                  {form.trackerProvider === 'jira' ? (
                    <div className="grid gap-4 rounded-2xl border border-line bg-overlay/40 p-4">
                      <Field label="Base URL" hint="Your Jira Cloud or Server site, including protocol.">
                        <Input
                          name="jiraBaseUrl"
                          value={form.jiraBaseUrl}
                          onChange={handleChange}
                          placeholder="https://your-org.atlassian.net"
                        />
                      </Field>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Username (email)">
                          <Input
                            name="jiraUsername"
                            value={form.jiraUsername}
                            onChange={handleChange}
                            placeholder="you@company.com"
                          />
                        </Field>
                        <Field label="API token">
                          <Input
                            name="jiraApiToken"
                            type="password"
                            value={form.jiraApiToken}
                            onChange={handleChange}
                            placeholder="Atlassian API token"
                          />
                        </Field>
                      </div>
                    </div>
                  ) : null}

                  {form.trackerProvider === 'github' ? (
                    <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-sm text-fg-muted">
                      {form.gitProvider === 'github' && form.gitToken
                        ? `The campaign planner will reuse the configured GitHub token for ${form.gitWorkspace || 'the current owner'}. Make sure it includes repo and issues write scopes.`
                        : 'Set the Git provider to GitHub and fill in the token plus organization. The tracker will reuse those credentials.'}
                    </div>
                  ) : null}

                  {form.trackerProvider === 'linear' ? (
                    <div className="grid gap-4 rounded-2xl border border-line bg-overlay/40 p-4">
                      <Field label="API key" hint="Personal API key from linear.app/settings/api.">
                        <Input
                          name="linearApiKey"
                          type="password"
                          value={form.linearApiKey}
                          onChange={handleChange}
                          placeholder="lin_api_…"
                        />
                      </Field>
                      <Field
                        label="Default team key"
                        hint="Used when the campaign planner does not override the target team."
                      >
                        <Input
                          name="linearTeamKey"
                          value={form.linearTeamKey}
                          onChange={handleChange}
                          placeholder="ENG"
                        />
                      </Field>
                    </div>
                  ) : null}
                </div>
              </SectionCard>
            </TabsContent>

            <TabsContent value="paths" className="space-y-6">
              <SectionCard
                title="Paths"
                description="Filesystem locations the runner uses for intelligence materialization and working repositories."
              >
                <div className="space-y-4">
                  <Field
                    label="Intelligence directory"
                    hint="Leave blank to use the resolved default shown in the sidebar."
                  >
                    <Input
                      name="intelligenceDir"
                      value={form.intelligenceDir}
                      onChange={handleChange}
                      placeholder={meta?.resolved.intelligenceDir ?? '~/.coro/intelligence'}
                    />
                  </Field>
                  <Field
                    label="Intelligence git remote"
                    hint="URL of your tenant intelligence Git repository. Used when merging overlays and for tenant-layer propose_change PRs — you do not need a separate tenant.overlay block. An empty remote on the server is fine; the runner clones it on first proposal."
                  >
                    <Input
                      name="intelligenceRemote"
                      value={form.intelligenceRemote}
                      onChange={handleChange}
                      placeholder="https://github.com/org/coro-intelligence.git"
                    />
                  </Field>
                  <Field
                    label="Working directory"
                    hint="Where repositories are cloned during job execution."
                  >
                    <Input
                      name="workingDir"
                      value={form.workingDir}
                      onChange={handleChange}
                      placeholder={meta?.resolved.workingDir ?? '~/.coro/working'}
                    />
                  </Field>
                </div>
              </SectionCard>
            </TabsContent>
          </Tabs>
        </div>

        <div className="space-y-4 xl:sticky xl:top-6 xl:self-start">
          <Card>
            <CardHeader>
              <CardTitle>Runner summary</CardTitle>
              <CardDescription>
                What the runner will use right now, including defaults resolved from the host environment.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <SummaryField label="Config path" value={meta?.configPath ?? '—'} mono />
              <Separator />
              <SummaryField
                label="Resolved intelligence dir"
                value={meta?.resolved.intelligenceDir ?? '—'}
                mono
              />
              <SummaryField
                label="Resolved working dir"
                value={meta?.resolved.workingDir ?? '—'}
                mono
              />
              <Separator />
              <div className="space-y-2 text-fg-muted">
                <SummaryRow label="Auth method" value={form.anthropicMethod} />
                <SummaryRow label="Claude session" value={claudeLoginReady ? 'Ready' : 'Not ready'} />
                <SummaryRow label="Tracker" value={form.trackerProvider} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Save changes</CardTitle>
              <CardDescription>
                {form.anthropicMethod === 'claudeLogin'
                  ? 'Claude login must be connected before this auth mode can be saved.'
                  : 'Most changes take effect after the runner restarts.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={saving || (form.anthropicMethod === 'claudeLogin' && !claudeLoginReady)}
              >
                {saving ? 'Saving…' : 'Save configuration'}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => void loadConfig()}
              >
                Reload from disk
              </Button>
            </CardContent>
          </Card>

          {effectiveClaudeAccount ? (
            <Card>
              <CardHeader>
                <CardTitle>Connected Claude account</CardTitle>
                <CardDescription>Session metadata reported by Claude Code.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {effectiveClaudeAccount.email ? (
                  <AccountFact label="Email" value={effectiveClaudeAccount.email} />
                ) : null}
                <AccountFact
                  label="Provider"
                  value={formatProvider(effectiveClaudeAccount.apiProvider)}
                />
                <AccountFact
                  label="Plan"
                  value={effectiveClaudeAccount.subscriptionType ?? 'Not reported'}
                />
              </CardContent>
            </Card>
          ) : null}
        </div>
      </form>
    </div>
  )
}

function SummaryField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.16em] text-fg-subtle">{label}</div>
      <div className={cn('mt-1 break-all text-fg', mono && 'font-mono text-[12px]')}>{value}</div>
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle">{label}</span>
      <span className="text-fg">{value}</span>
    </div>
  )
}
