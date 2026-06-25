import { useEffect, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import Field from '../../../components/forms/field'
import SettingsNotice from '../../../components/settings/SettingsNotice'
import ChoiceGroup from '../../../components/settings/ChoiceGroup'
import SecretInput from '../../../components/settings/SecretInput'
import SettingsStatusBadge, {
  type SettingStatus,
} from '../../../components/settings/StatusBadge'
import { useSettings } from '../SettingsContext'
import { ApiError, jsonRequest, requestJson } from '../../../lib/http'
import TestConnectionButton, {
  type TestConnectionResult,
} from '../../../components/settings/TestConnectionButton'

// ── Anthropic-specific types ──────────────────────────────────────────────
//
// These used to live on SettingsContext while Anthropic was hard-wired
// into the runner. They are now scoped to this custom panel; other
// executor plugins won't import them.

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

const ANTHROPIC_OPTIONS = [
  {
    value: 'claudeLogin' as const,
    label: 'Claude login',
    description: "Recommended. Uses Claude Code's local session and MCP permissions.",
  },
  {
    value: 'apiKey' as const,
    label: 'API key',
    description: 'Direct Anthropic billing with explicit service credentials.',
  },
  {
    value: 'oauth' as const,
    label: 'Legacy OAuth token',
    description: 'Fallback only. Stores a raw token without session refresh.',
  },
]

interface AnthropicAuthPanelProps {
  pluginId: string
  /** Optional callback fired once Claude is connected (used by the wizard). */
  onConnected?: () => void
}

/**
 * Custom configuration panel for the `@coro-ai/llm-anthropic` executor
 * plugin. Selected by `manifest.ui.customPanel === 'anthropic-auth'`
 * via the {@link customPanels} registry. Treated as a standalone
 * provider plugin so the rest of the dashboard contains no
 * Anthropic-specific branches.
 */
export default function AnthropicAuthPanel({ pluginId, onConnected }: AnthropicAuthPanelProps) {
  const { draft, setPluginField } = useSettings()
  const entry = draft.pluginInstalled[pluginId]
  const cfg = (entry?.config ?? {}) as {
    method?: AnthropicMethod
    apiKey?: string
    oauthToken?: string
    account?: ClaudeAccountInfo
  }
  const method: AnthropicMethod = cfg.method ?? 'claudeLogin'
  const apiKey = cfg.apiKey ?? ''
  const oauthToken = cfg.oauthToken ?? ''
  const persistedAccount = cfg.account ?? null

  const [claudeLogin, setClaudeLogin] = useState<ClaudeLoginState>({ status: 'idle' })
  const [connecting, setConnecting] = useState(false)
  const [submittingCallback, setSubmittingCallback] = useState(false)
  const [callbackInput, setCallbackInput] = useState('')
  const [callbackState, setCallbackState] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [oauthGenerating, setOauthGenerating] = useState(false)
  const [oauthStatus, setOauthStatus] = useState<string | null>(null)
  const [oauthAuthUrl, setOauthAuthUrl] = useState<string | null>(null)
  const [oauthCliMissing, setOauthCliMissing] = useState(false)

  // Bootstrap: if the persisted config already says claudeLogin, present
  // the panel as 'connected' so the user sees their existing account.
  useEffect(() => {
    if (method === 'claudeLogin' && claudeLogin.status === 'idle' && persistedAccount) {
      setClaudeLogin({ status: 'connected', account: persistedAccount })
    }
  }, [method, persistedAccount, claudeLogin.status])

  // Background polling while a Claude login is mid-flight.
  useEffect(() => {
    if (claudeLogin.status !== 'authorizing') return
    const timer = window.setInterval(async () => {
      try {
        const data = await requestJson<ClaudeLoginState>('/config/anthropic/claude-login/status')
        if (data.status === 'idle') return
        setClaudeLogin(data)
        if (data.status === 'connected') {
          setPluginField(pluginId, 'method', 'claudeLogin')
          if (data.account) setPluginField(pluginId, 'account', data.account)
          onConnected?.()
        }
      } catch {
        // Soft fail — surfaced by explicit user actions instead.
      }
    }, 2000)
    return () => window.clearInterval(timer)
  }, [claudeLogin.status, pluginId, setPluginField, onConnected])

  const effectiveAccount = claudeLogin.account ?? persistedAccount
  const claudeLoginUrl = claudeLogin.automaticUrl ?? claudeLogin.manualUrl ?? null
  const claudeLoginReady = claudeLogin.status === 'connected' || !!effectiveAccount

  function setMethod(next: AnthropicMethod) {
    setPluginField(pluginId, 'method', next)
    setError(null)
    setOauthStatus(null)
    setOauthAuthUrl(null)
  }

  async function startClaudeLogin(forceReauth = false) {
    setConnecting(true)
    setError(null)
    try {
      const data = await requestJson<ClaudeLoginState>(
        '/config/anthropic/claude-login/start',
        forceReauth
          ? jsonRequest({ force: true }, { method: 'POST' })
          : { method: 'POST' },
      )
      setClaudeLogin(data)
      setPluginField(pluginId, 'method', 'claudeLogin')
      if (data.account) setPluginField(pluginId, 'account', data.account)
      if (data.status === 'connected') {
        onConnected?.()
        return
      }
      if (data.status === 'authorizing' && (data.automaticUrl || data.manualUrl)) {
        window.open(data.automaticUrl ?? data.manualUrl, '_blank', 'noopener,noreferrer')
      }
      if (data.status === 'error') throw new Error(data.error ?? 'Claude login failed to start.')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setConnecting(false)
    }
  }

  async function submitManualCallback() {
    setSubmittingCallback(true)
    setError(null)
    try {
      const callback = parseClaudeCallbackInput(callbackInput, callbackState)
      const data = await requestJson<ClaudeLoginState>(
        '/config/anthropic/claude-login/callback',
        jsonRequest(callback, { method: 'POST' }),
      )
      setClaudeLogin(data)
      if (data.status !== 'connected') throw new Error(data.error ?? 'Claude login did not complete.')
      setPluginField(pluginId, 'method', 'claudeLogin')
      if (data.account) setPluginField(pluginId, 'account', data.account)
      setCallbackInput('')
      setCallbackState('')
      onConnected?.()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setSubmittingCallback(false)
    }
  }

  /**
   * Hit `POST /test/llm` with the panel's current draft config. The
   * runner dispatches through the Anthropic plugin's own
   * `testConnection`, which performs the real API probe — including
   * reading the local Claude Code OAuth session from the platform's
   * credential store for `method=claudeLogin`. This is the only path
   * that catches the "Claude says I'm logged in but Anthropic still
   * 401s" failure mode, so it's important the user has a one-click
   * way to run it from Settings.
   */
  async function testConnection(): Promise<TestConnectionResult> {
    try {
      return await requestJson<TestConnectionResult>(
        '/test/llm',
        jsonRequest({ provider: pluginId, config: cfg }, { method: 'POST' }),
      )
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      }
    }
  }

  const canTest =
    method === 'claudeLogin'
      ? claudeLogin.status === 'connected' || !!persistedAccount
      : method === 'apiKey'
        ? apiKey.length > 0
        : oauthToken.length > 0

  async function generateOauthToken() {
    setOauthGenerating(true)
    setOauthStatus('Launching Claude Code login. Complete sign-in in your browser…')
    setOauthAuthUrl(null)
    setError(null)
    try {
      const data = await requestJson<LegacyOauthResponse>('/config/anthropic/generate-oauth-token', {
        method: 'POST',
      })
      if (data.authUrl) setOauthAuthUrl(data.authUrl)
      if (data.token) {
        setPluginField(pluginId, 'oauthToken', data.token)
        setPluginField(pluginId, 'method', 'oauth')
        setOauthStatus(`Token captured (${data.token.slice(0, 16)}…). Click Save to persist it.`)
      } else {
        setError('Token generation returned no token.')
        setOauthStatus(null)
      }
    } catch (err) {
      if (err instanceof ApiError) {
        const payload = err.payload as LegacyOauthResponse | null
        if (payload?.authUrl) setOauthAuthUrl(payload.authUrl)
        if (payload?.error === 'CLI_NOT_FOUND' || payload?.error === 'PLATFORM_UNSUPPORTED') {
          setOauthCliMissing(true)
        }
        setError(payload?.message ?? payload?.stderr ?? err.message)
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
      setOauthStatus(null)
    } finally {
      setOauthGenerating(false)
    }
  }

  return (
    <div className="space-y-5">
      <Field label="Authentication method">
        <ChoiceGroup<AnthropicMethod>
          name={`${pluginId}-anthropic-method`}
          value={method}
          onChange={setMethod}
          options={ANTHROPIC_OPTIONS}
          cols={3}
        />
      </Field>

      {error ? <SettingsNotice tone="danger">{error}</SettingsNotice> : null}

      {method === 'claudeLogin' ? (
        <div className="space-y-4 rounded-2xl border border-line bg-overlay/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <SettingsStatusBadge
                status={statusForClaude(claudeLogin)}
                label={statusLabelForClaude(claudeLogin)}
              />
              {effectiveAccount?.email ? (
                <span className="text-sm text-fg-muted">{effectiveAccount.email}</span>
              ) : null}
            </div>
            <Button
              type="button"
              size="sm"
              onClick={() => void startClaudeLogin(claudeLoginReady)}
              disabled={connecting}
            >
              {connecting ? 'Starting…' : claudeLoginReady ? 'Reconnect' : 'Connect Claude'}
            </Button>
          </div>

          <p className="text-sm text-fg-muted">
            Uses Claude Code's local login session, including MCP permissions and session refresh. No copy-pasted token is stored in Coro.
          </p>

          {effectiveAccount ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <AccountFact label="Provider" value={formatProvider(effectiveAccount.apiProvider)} />
              <AccountFact label="Organization" value={effectiveAccount.organization ?? 'Not reported'} />
              <AccountFact label="Plan" value={effectiveAccount.subscriptionType ?? 'Not reported'} />
              <AccountFact label="Token source" value={effectiveAccount.tokenSource ?? 'Not reported'} />
            </div>
          ) : null}

          {claudeLogin.status === 'authorizing' ? (
            <div className="space-y-3">
              <SettingsNotice tone="warning">
                Waiting for the Claude browser login to finish. This panel polls automatically.
              </SettingsNotice>

              {claudeLoginUrl ? (
                <div className="rounded-xl border border-line bg-canvas/40 px-3 py-2.5 text-xs text-fg-muted">
                  <div>Browser blocked? Continue here:</div>
                  <a
                    href={claudeLoginUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1 block break-all text-accent-300 hover:text-accent-400"
                  >
                    {claudeLoginUrl}
                  </a>
                </div>
              ) : null}

              <div className="grid gap-3 rounded-xl border border-line bg-canvas/40 p-3">
                <Field
                  label="Callback URL or authorization code"
                  hint="Use this only if automatic completion fails."
                >
                  <Input
                    value={callbackInput}
                    onChange={event => setCallbackInput(event.target.value)}
                    placeholder="Paste the redirected URL or the code parameter"
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                  <Field label="State override" hint="Optional if you pasted a raw authorization code.">
                    <Input
                      value={callbackState}
                      onChange={event => setCallbackState(event.target.value)}
                      placeholder="Optional state"
                    />
                  </Field>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void submitManualCallback()}
                    disabled={submittingCallback}
                  >
                    {submittingCallback ? 'Completing…' : 'Complete manually'}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {method === 'apiKey' ? (
        <Field label="API key" required hint="Anthropic API key from console.anthropic.com.">
          <SecretInput
            value={apiKey}
            onChange={event => setPluginField(pluginId, 'apiKey', event.target.value)}
            placeholder="sk-ant-…"
          />
        </Field>
      ) : null}

      {method === 'oauth' ? (
        <div className="space-y-4">
          <Field label="OAuth token" required hint="Legacy fallback only. Prefer Claude login whenever possible.">
            <SecretInput
              value={oauthToken}
              onChange={event => setPluginField(pluginId, 'oauthToken', event.target.value)}
              placeholder="sk-ant-oat01-…"
            />
          </Field>

          {!oauthCliMissing ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void generateOauthToken()}
              disabled={oauthGenerating}
            >
              <KeyRound />
              {oauthGenerating ? 'Generating…' : 'Generate via claude setup-token'}
            </Button>
          ) : null}

          {oauthStatus ? <SettingsNotice tone="success">{oauthStatus}</SettingsNotice> : null}
          {oauthAuthUrl ? (
            <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3 text-sm text-fg-muted">
              <div>Browser blocked? Sign in here:</div>
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
      ) : null}

      {/*
        Active credential probe. Always rendered (any of the three
        methods can fail in a way the dashboard's local status
        wouldn't catch — most notably claudeLogin, where the local
        keychain entry can be present-but-revoked).
      */}
      <div className="border-t border-line pt-4">
        <TestConnectionButton
          onTest={testConnection}
          disabled={!canTest}
          label="Test connection"
        />
        <p className="mt-2 text-[12px] text-fg-subtle">
          Sends a 1-token <span className="font-mono">/v1/messages</span> ping with your current credentials.
          For Claude login, reads the OAuth session from your local keychain.
        </p>
      </div>
    </div>
  )
}

// ── helpers ───────────────────────────────────────────────────────────────

function formatProvider(provider: ClaudeAccountInfo['apiProvider']): string {
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

function AccountFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-overlay/40 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-[0.16em] text-fg-subtle">{label}</div>
      <div className="mt-1 text-sm text-fg">{value}</div>
    </div>
  )
}

function statusForClaude(state: ClaudeLoginState): SettingStatus {
  switch (state.status) {
    case 'connected':
      return 'ok'
    case 'authorizing':
      return 'pending'
    case 'error':
      return 'error'
    default:
      return 'unset'
  }
}

function statusLabelForClaude(state: ClaudeLoginState): string {
  switch (state.status) {
    case 'connected':
      return 'Connected'
    case 'authorizing':
      return 'Waiting for browser'
    case 'error':
      return 'Failed'
    default:
      return 'Not connected'
  }
}
