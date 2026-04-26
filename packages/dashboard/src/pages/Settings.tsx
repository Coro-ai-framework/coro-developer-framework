import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'

type AnthropicMethod = 'apiKey' | 'claudeLogin' | 'oauth'

interface ClaudeAccountInfo {
  email?: string
  organization?: string
  subscriptionType?: string
  tokenSource?: string
  apiKeySource?: string
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
  } | null
  configPath: string
  mode: 'hybrid' | 'local' | 'legacy'
  resolved: {
    intelligenceDir: string
    workingDir: string
  } | null
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
  tokenKind?: string
  mcpCompatible?: boolean
  limitation?: string
  recommendation?: string
}

const EMPTY_FORM: SettingsForm = {
  anthropicMethod: 'apiKey',
  apiKey: '',
  oauthToken: '',
  intelligenceDir: '',
  intelligenceRemote: '',
  workingDir: '',
  gitProvider: 'github',
  gitUsername: '',
  gitToken: '',
  gitWorkspace: '',
}

const EMPTY_CLAUDE_LOGIN_STATE: ClaudeLoginState = { status: 'idle' }

function labelClass() {
  return 'block text-xs font-medium text-zinc-400 mb-1'
}

function inputClass() {
  return 'w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors'
}

function authTabClass(active: boolean) {
  return `flex-1 px-3 py-2 rounded-lg border text-sm transition-colors ${
    active
      ? 'bg-indigo-950/50 border-indigo-600 text-indigo-200'
      : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200'
  }`
}

function statusBadgeClass(status: ClaudeLoginState['status']) {
  switch (status) {
    case 'connected':
      return 'bg-emerald-900/50 text-emerald-300 border border-emerald-800'
    case 'authorizing':
      return 'bg-indigo-900/50 text-indigo-300 border border-indigo-800'
    case 'error':
      return 'bg-rose-900/50 text-rose-300 border border-rose-800'
    default:
      return 'bg-zinc-800 text-zinc-300 border border-zinc-700'
  }
}

function statusLabel(status: ClaudeLoginState['status']) {
  switch (status) {
    case 'connected':
      return 'Connected'
    case 'authorizing':
      return 'Waiting for browser login'
    case 'error':
      return 'Needs attention'
    default:
      return 'Not connected'
  }
}

function FieldHint({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-xs text-zinc-500">{children}</p>
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

export default function Settings() {
  const [form, setForm] = useState<SettingsForm>(EMPTY_FORM)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ configPath: string; mode: string; resolved: ConfigResponse['resolved'] } | null>(null)

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

  const effectiveClaudeAccount = claudeLoginState.account ?? claudeLoginAccount
  const claudeLoginReady = claudeLoginState.status === 'connected' || !!effectiveClaudeAccount
  const claudeLoginUrl = claudeLoginState.automaticUrl ?? claudeLoginState.manualUrl ?? null

  useEffect(() => {
    void loadConfig()
  }, [])

  useEffect(() => {
    if (claudeLoginState.status !== 'authorizing') {
      return
    }

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
      const res = await fetch('/config')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as ConfigResponse

      setMeta({ configPath: data.configPath, mode: data.mode, resolved: data.resolved })

      const anthropic = data.config?.anthropic
      const savedAccount = anthropic?.account ?? null
      setClaudeLoginAccount(savedAccount)
      setClaudeLoginState(prev => {
        if (prev.status === 'authorizing') {
          return prev
        }
        if (anthropic?.method === 'claudeLogin') {
          return savedAccount
            ? { status: 'connected', account: savedAccount }
            : { status: 'connected' }
        }
        return EMPTY_CLAUDE_LOGIN_STATE
      })

      if (data.config) {
        setForm({
          anthropicMethod: anthropic?.method ?? 'apiKey',
          apiKey: anthropic?.apiKey ?? '',
          oauthToken: anthropic?.oauthToken ?? '',
          intelligenceDir: data.config.intelligence?.dir ?? '',
          intelligenceRemote: data.config.intelligence?.gitRemote ?? '',
          workingDir: data.config.paths?.workingDir ?? '',
          gitProvider: data.config.git?.provider ?? 'github',
          gitUsername: data.config.git?.username ?? '',
          gitToken: data.config.git?.token ?? '',
          gitWorkspace: data.config.git?.workspace ?? '',
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function refreshClaudeLoginStatus() {
    try {
      const res = await fetch('/config/anthropic/claude-login/status')
      const data = await res.json().catch(() => ({})) as ClaudeLoginState & { error?: string }

      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }

      if (data.status === 'idle') {
        return
      }

      setClaudeLoginState(data)
      if (data.account) {
        setClaudeLoginAccount(data.account)
      }

      if (data.status === 'connected') {
        setForm(prev => ({ ...prev, anthropicMethod: 'claudeLogin' }))
        setSuccess('Claude account connected. The runner will use Claude Code\'s local login session, including MCP permissions.')
        setError(null)
        setClaudeLoginCallbackInput('')
        setClaudeLoginCallbackState('')
      } else if (data.status === 'error') {
        setError(data.error ?? 'Claude login failed.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function handleChange(e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }))
    setSuccess(null)
  }

  function setAnthropicMethod(method: AnthropicMethod) {
    setForm(prev => ({ ...prev, anthropicMethod: method }))
    setSuccess(null)
    setOauthStatus(null)
    setOauthAuthUrl(null)
  }

  async function handleStartClaudeLogin() {
    setClaudeLoginConnecting(true)
    setError(null)
    setSuccess(null)

    try {
      const res = await fetch('/config/anthropic/claude-login/start', { method: 'POST' })
      const data = await res.json().catch(() => ({})) as ClaudeLoginState & { error?: string }

      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }

      setClaudeLoginState(data)
      if (data.account) {
        setClaudeLoginAccount(data.account)
      }
      setForm(prev => ({ ...prev, anthropicMethod: 'claudeLogin' }))

      if (data.status === 'connected') {
        setSuccess('Claude account connected. Configuration was updated to use Claude Code\'s local session.')
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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
      const res = await fetch('/config/anthropic/claude-login/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(callback),
      })

      const data = await res.json().catch(() => ({})) as ClaudeLoginState & { error?: string }
      if (!res.ok) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }

      setClaudeLoginState(data)
      if (data.account) {
        setClaudeLoginAccount(data.account)
      }

      if (data.status !== 'connected') {
        throw new Error(data.error ?? 'Claude login did not complete.')
      }

      setForm(prev => ({ ...prev, anthropicMethod: 'claudeLogin' }))
      setClaudeLoginCallbackInput('')
      setClaudeLoginCallbackState('')
      setSuccess('Claude account connected. Configuration was updated to use Claude Code\'s local session.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setClaudeLoginSubmittingCallback(false)
    }
  }

  async function handleGenerateOauthToken() {
    setOauthGenerating(true)
    setOauthStatus('Launching Claude Code login. Complete the sign-in in your browser; the legacy token will be filled in automatically if the CLI can extract it.')
    setOauthAuthUrl(null)
    setError(null)

    try {
      const res = await fetch('/config/anthropic/generate-oauth-token', { method: 'POST' })
      const data = await res.json().catch(() => ({})) as LegacyOauthResponse

      if (data.authUrl) setOauthAuthUrl(data.authUrl)

      if (!res.ok) {
        if (data.error === 'CLI_NOT_FOUND') {
          setOauthCliMissing(true)
          setError(data.message ?? 'Could not find a Claude Code CLI on the runner host. Reinstall the runner or paste a token generated elsewhere.')
        } else if (data.error === 'IN_PROGRESS') {
          setError('Another token setup is already running on this runner.')
        } else if (data.error === 'TIMEOUT') {
          setError(
            data.authUrl
              ? 'Token setup timed out. If a browser did not open automatically, use the sign-in link below and try again.'
              : 'Token setup timed out after 120 seconds. Try again.',
          )
        } else if (data.error === 'NO_CONTROLLING_TTY') {
          setError(data.message ?? 'The runner has no controlling terminal. Start the runner from a terminal and retry, or paste a token manually.')
        } else if (data.error === 'PLATFORM_UNSUPPORTED') {
          setOauthCliMissing(true)
          setError(data.message ?? 'Automatic token generation is only supported on macOS and Linux. Run `claude setup-token` in a terminal and paste the token below.')
        } else {
          setError(data.message ?? data.stderr ?? data.error ?? `HTTP ${res.status}`)
        }
        setOauthStatus(null)
        return
      }

      if (data.token) {
        const tok = data.token
        const looksValid = /^sk-ant-oat\d+-/.test(tok) || /^sk-ant-/.test(tok)
        const scopeMsg = data.scopeRequestSupported
          ? (data.requestedScopes?.length
              ? ` Requested scopes: ${data.requestedScopes.join(', ')}.`
              : '')
          : ' Your installed Claude CLI did not expose scope flags, so token scopes were not explicitly requested.'
        const reauthMsg = data.forcedReauth
          ? ' Forced re-auth was requested to avoid cached older-scope tokens.'
          : ''
        const limitationMsg = data.limitation ? ` ${data.limitation}` : ''
        const recommendationMsg = data.recommendation ? ` ${data.recommendation}` : ''
        setForm(prev => ({ ...prev, oauthToken: tok, anthropicMethod: 'oauth' }))
        setOauthStatus(
          looksValid
            ? `Token generated (${tok.slice(0, 16)}…).${scopeMsg}${reauthMsg}${limitationMsg}${recommendationMsg} Click Save to persist it.`
            : `Captured value does not look like an Anthropic OAuth token (got "${tok.slice(0, 24)}…").${scopeMsg}${reauthMsg}${limitationMsg}${recommendationMsg} Regenerate or paste a token manually.`,
        )
        setOauthAuthUrl(null)
      } else {
        setError('Token generation returned no token.')
        setOauthStatus(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setOauthStatus(null)
    } finally {
      setOauthGenerating(false)
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
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

      const body: Record<string, unknown> = {
        anthropic,
        intelligence: {
          dir: form.intelligenceDir || undefined,
          gitRemote: form.intelligenceRemote || undefined,
        },
        paths: { workingDir: form.workingDir || undefined },
        git: form.gitUsername ? {
          provider: form.gitProvider,
          username: form.gitUsername,
          token: form.gitToken,
          workspace: form.gitWorkspace || undefined,
        } : undefined,
      }

      const res = await fetch('/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
      }

      setSuccess(
        form.anthropicMethod === 'claudeLogin'
          ? 'Configuration saved. The runner will use Claude Code\'s local login session.'
          : 'Configuration saved. Restart the runner for changes to take effect.',
      )
      await loadConfig()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="text-zinc-400 text-sm">Loading configuration...</div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-white">Settings</h1>
        <p className="text-sm text-zinc-400 mt-1">Configure the Coro runner. Changes are saved to the local config file.</p>
      </div>

      {meta && (
        <div className="mb-6 p-4 rounded-lg bg-zinc-900 border border-zinc-800 space-y-2">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Mode</span>
            <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
              meta.mode === 'local'
                ? 'bg-emerald-900/50 text-emerald-400 border border-emerald-800'
                : meta.mode === 'hybrid'
                  ? 'bg-indigo-900/50 text-indigo-400 border border-indigo-800'
                  : 'bg-amber-900/50 text-amber-400 border border-amber-800'
            }`}>
              {meta.mode}
            </span>
          </div>
          <div className="text-xs text-zinc-500">
            Config: <span className="text-zinc-400 font-mono">{meta.configPath}</span>
          </div>
          {meta.resolved && (
            <>
              <div className="text-xs text-zinc-500">
                Intelligence: <span className="text-zinc-400 font-mono">{meta.resolved.intelligenceDir}</span>
              </div>
              <div className="text-xs text-zinc-500">
                Working dir: <span className="text-zinc-400 font-mono">{meta.resolved.workingDir}</span>
              </div>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="mb-6 p-3 rounded-lg bg-rose-950/50 border border-rose-900 text-sm text-rose-300">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-6 p-3 rounded-lg bg-emerald-950/50 border border-emerald-900 text-sm text-emerald-300">
          {success}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-8">
        <section>
          <h2 className="text-sm font-semibold text-zinc-300 mb-4 pb-2 border-b border-zinc-800">Anthropic</h2>

          <div className="mb-5 flex flex-col sm:flex-row gap-2" role="radiogroup" aria-label="Anthropic auth method">
            <button
              type="button"
              role="radio"
              aria-checked={form.anthropicMethod === 'claudeLogin'}
              onClick={() => setAnthropicMethod('claudeLogin')}
              className={authTabClass(form.anthropicMethod === 'claudeLogin')}
            >
              Claude login
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={form.anthropicMethod === 'apiKey'}
              onClick={() => setAnthropicMethod('apiKey')}
              className={authTabClass(form.anthropicMethod === 'apiKey')}
            >
              API key
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={form.anthropicMethod === 'oauth'}
              onClick={() => setAnthropicMethod('oauth')}
              className={authTabClass(form.anthropicMethod === 'oauth')}
            >
              OAuth token (legacy)
            </button>
          </div>

          {form.anthropicMethod === 'claudeLogin' ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-4 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Recommended authentication</div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`px-2 py-0.5 rounded text-xs font-semibold ${statusBadgeClass(claudeLoginState.status)}`}>
                        {statusLabel(claudeLoginState.status)}
                      </span>
                      {effectiveClaudeAccount?.email && (
                        <span className="text-sm text-zinc-200">{effectiveClaudeAccount.email}</span>
                      )}
                    </div>
                    <FieldHint>
                      Uses Claude Code&apos;s own local login session, including MCP permissions and session refresh. No copy-pasted token is stored in Coro.
                    </FieldHint>
                  </div>

                  <button
                    type="button"
                    onClick={handleStartClaudeLogin}
                    disabled={claudeLoginConnecting}
                    className="px-3 py-2 rounded-lg bg-indigo-600 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {claudeLoginConnecting
                      ? 'Starting Claude login…'
                      : claudeLoginReady
                        ? 'Reconnect Claude'
                        : 'Connect Claude'}
                  </button>
                </div>

                {effectiveClaudeAccount && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                    <div className="rounded-lg bg-zinc-950/70 border border-zinc-800 px-3 py-2">
                      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Provider</div>
                      <div className="text-zinc-200">{formatProvider(effectiveClaudeAccount.apiProvider)}</div>
                    </div>
                    <div className="rounded-lg bg-zinc-950/70 border border-zinc-800 px-3 py-2">
                      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Organization</div>
                      <div className="text-zinc-200">{effectiveClaudeAccount.organization ?? 'Not reported'}</div>
                    </div>
                    <div className="rounded-lg bg-zinc-950/70 border border-zinc-800 px-3 py-2">
                      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Plan</div>
                      <div className="text-zinc-200">{effectiveClaudeAccount.subscriptionType ?? 'Not reported'}</div>
                    </div>
                    <div className="rounded-lg bg-zinc-950/70 border border-zinc-800 px-3 py-2">
                      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Token source</div>
                      <div className="text-zinc-200">{effectiveClaudeAccount.tokenSource ?? 'Not reported'}</div>
                    </div>
                  </div>
                )}
              </div>

              {claudeLoginState.status === 'authorizing' && (
                <div className="space-y-3">
                  <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-300">
                    The runner is waiting for the Claude browser login to finish. This page polls for completion automatically.
                  </div>

                  {claudeLoginUrl && (
                    <div className="p-3 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-400 space-y-2">
                      <div>If the browser did not open automatically, continue the sign-in flow here:</div>
                      <a
                        href={claudeLoginUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-all text-indigo-400 hover:text-indigo-300 underline"
                      >
                        {claudeLoginUrl}
                      </a>
                    </div>
                  )}

                  <div className="rounded-lg bg-zinc-900 border border-zinc-800 p-4 space-y-3">
                    <div>
                      <label className={labelClass()}>Callback URL or Authorization Code</label>
                      <input
                        value={claudeLoginCallbackInput}
                        onChange={e => setClaudeLoginCallbackInput(e.target.value)}
                        placeholder="Paste the redirected URL or the code parameter"
                        className={inputClass()}
                      />
                      <FieldHint>
                        Use this only if automatic completion fails. Pasting the full redirected URL is preferred because it includes the OAuth state value.
                      </FieldHint>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
                      <div>
                        <label className={labelClass()}>State Override</label>
                        <input
                          value={claudeLoginCallbackState}
                          onChange={e => setClaudeLoginCallbackState(e.target.value)}
                          placeholder="Optional if you pasted a raw authorization code"
                          className={inputClass()}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={handleSubmitClaudeLoginCallback}
                        disabled={claudeLoginSubmittingCallback}
                        className="px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {claudeLoginSubmittingCallback ? 'Completing…' : 'Complete login manually'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {claudeLoginState.status === 'error' && claudeLoginState.error && (
                <div className="p-3 rounded-lg bg-rose-950/50 border border-rose-900 text-sm text-rose-300">
                  {claudeLoginState.error}
                </div>
              )}
            </div>
          ) : form.anthropicMethod === 'apiKey' ? (
            <div>
              <label className={labelClass()}>API Key <span className="text-rose-400">*</span></label>
              <input
                name="apiKey"
                type="password"
                value={form.apiKey}
                onChange={handleChange}
                placeholder="sk-ant-..."
                className={inputClass()}
              />
              <FieldHint>Anthropic API key from console.anthropic.com — billed per token.</FieldHint>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className={labelClass()}>OAuth Token <span className="text-rose-400">*</span></label>
                <input
                  name="oauthToken"
                  type="password"
                  value={form.oauthToken}
                  onChange={handleChange}
                  placeholder="sk-ant-oat01-..."
                  className={inputClass()}
                />
                <FieldHint>
                  Legacy fallback only. This stores a single raw OAuth token value and does not preserve Claude Code&apos;s richer session state or MCP-capable login context.
                </FieldHint>
                <FieldHint>
                  If you need MCP-enabled workflows in this app, prefer Claude login or an API key. OAuth tokens remain personal-use only per Anthropic&apos;s ToS.
                </FieldHint>
              </div>

              {!oauthCliMissing && (
                <button
                  type="button"
                  onClick={handleGenerateOauthToken}
                  disabled={oauthGenerating}
                  className="px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {oauthGenerating ? 'Generating legacy token…' : 'Generate legacy token via claude setup-token'}
                </button>
              )}

              {oauthStatus && (
                <div className="p-2 rounded bg-zinc-900 border border-zinc-800 text-xs text-zinc-400">
                  {oauthStatus}
                </div>
              )}

              {oauthAuthUrl && (
                <div className="p-2 rounded bg-zinc-900 border border-zinc-800 text-xs text-zinc-400 space-y-1">
                  <div>If the browser did not open automatically, sign in here:</div>
                  <a
                    href={oauthAuthUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-indigo-400 hover:text-indigo-300 underline"
                  >
                    {oauthAuthUrl}
                  </a>
                </div>
              )}
            </div>
          )}
        </section>

        <section>
          <h2 className="text-sm font-semibold text-zinc-300 mb-4 pb-2 border-b border-zinc-800">Git Provider</h2>
          <div className="space-y-4">
            <div>
              <label className={labelClass()}>Provider</label>
              <select
                name="gitProvider"
                value={form.gitProvider}
                onChange={handleChange}
                className={inputClass()}
              >
                <option value="github">GitHub</option>
                <option value="bitbucket">BitBucket</option>
                <option value="gitlab">GitLab</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass()}>Username</label>
                <input
                  name="gitUsername"
                  value={form.gitUsername}
                  onChange={handleChange}
                  placeholder="your-username"
                  className={inputClass()}
                />
              </div>
              <div>
                <label className={labelClass()}>
                  {form.gitProvider === 'github' ? 'Personal Access Token' : 'App Password'}
                </label>
                <input
                  name="gitToken"
                  type="password"
                  value={form.gitToken}
                  onChange={handleChange}
                  placeholder={form.gitProvider === 'github' ? 'ghp_...' : 'Token'}
                  className={inputClass()}
                />
              </div>
            </div>
            <div>
              <label className={labelClass()}>
                {form.gitProvider === 'bitbucket' ? 'Workspace slug' : 'Organization / Owner'}
              </label>
              <input
                name="gitWorkspace"
                value={form.gitWorkspace}
                onChange={handleChange}
                placeholder={form.gitProvider === 'bitbucket' ? 'my-workspace' : 'my-org'}
                className={inputClass()}
              />
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-zinc-300 mb-4 pb-2 border-b border-zinc-800">Paths</h2>
          <div className="space-y-4">
            <div>
              <label className={labelClass()}>Intelligence directory</label>
              <input
                name="intelligenceDir"
                value={form.intelligenceDir}
                onChange={handleChange}
                placeholder="~/.coro/intelligence"
                className={inputClass()}
              />
              <FieldHint>Directory containing agents/, workflows/, skills/, and memory/ (the Coro intelligence layer)</FieldHint>
            </div>
            <div>
              <label className={labelClass()}>Intelligence git remote</label>
              <input
                name="intelligenceRemote"
                value={form.intelligenceRemote}
                onChange={handleChange}
                placeholder="https://github.com/org/coro-intelligence.git (optional)"
                className={inputClass()}
              />
              <FieldHint>Git remote to pull intelligence updates from</FieldHint>
            </div>
            <div>
              <label className={labelClass()}>Working directory</label>
              <input
                name="workingDir"
                value={form.workingDir}
                onChange={handleChange}
                placeholder="~/.coro/working"
                className={inputClass()}
              />
              <FieldHint>Directory where repos are cloned during job execution</FieldHint>
            </div>
          </div>
        </section>

        <div className="pt-4 border-t border-zinc-800">
          <button
            type="submit"
            disabled={saving || (form.anthropicMethod === 'claudeLogin' && !claudeLoginReady)}
            className="px-5 py-2.5 rounded-lg bg-indigo-600 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      </form>
    </div>
  )
}