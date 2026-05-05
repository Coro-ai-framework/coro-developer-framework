import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { GitBranch, KeyRound, Plug, RefreshCcw, ShieldCheck, Ticket, Waypoints } from 'lucide-react'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { ApiError, jsonRequest, requestJson } from '../lib/http'
import { cn } from '../lib/utils'
import { toneClasses, type Tone } from '../lib/status'

type AnthropicMethod = 'apiKey' | 'claudeLogin' | 'oauth'
type TrackerProvider = 'none' | 'jira' | 'github' | 'linear'
type SettingsTab = 'anthropic' | 'plugins' | 'git' | 'tracker' | 'paths'

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
                        <div className="mt-1 text-sm text-fg">{pluginsState.defaults.scm ?? '— (single-installed wins)'}</div>
                      </div>
                      <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5">
                        <div className="text-[11px] uppercase tracking-[0.16em] text-fg-subtle">Default tracker</div>
                        <div className="mt-1 text-sm text-fg">{pluginsState.defaults.tracker ?? '— (single-installed wins)'}</div>
                      </div>
                    </div>

                    {pluginsState.plugins.length === 0 ? (
                      <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-sm text-fg-muted">
                        No plugins loaded. Configure credentials under the Git or Tracker tabs and the
                        runner will register the matching plugins automatically (legacy compatibility).
                        For a forward-looking config, add a `plugins` block to <code>~/.coro/config.json</code>.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {pluginsState.plugins.map(({ manifest, installed, mcpServer }) => (
                          <div
                            key={manifest.id}
                            className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <Plug className="size-4 text-fg-subtle" />
                                  <div className="text-[15px] font-medium text-fg">
                                    {manifest.displayName}
                                  </div>
                                  <span className="font-mono text-[11px] text-fg-subtle">{manifest.id}</span>
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
                                    Attached MCP server:{' '}
                                    <span className="font-mono">{mcpServer.type}</span>
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
                              </div>
                              <span
                                className={cn(
                                  'rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em]',
                                  toneClasses(installed ? 'success' : 'warning'),
                                )}
                              >
                                {installed ? 'enabled' : 'disabled'}
                              </span>
                            </div>
                          </div>
                        ))}
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
                    hint="Optional, but required by most hosted providers for PR and issue APIs."
                  >
                    <Input
                      name="gitWorkspace"
                      value={form.gitWorkspace}
                      onChange={handleChange}
                      placeholder={form.gitProvider === 'bitbucket' ? 'my-workspace' : 'my-org'}
                    />
                  </Field>
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
