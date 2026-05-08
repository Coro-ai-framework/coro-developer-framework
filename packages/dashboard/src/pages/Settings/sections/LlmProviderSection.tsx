import { useState, type ReactNode } from 'react'
import { KeyRound } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import Field from '../../../components/forms/field'
import SettingsSection from '../../../components/settings/SettingsSection'
import SettingsNotice from '../../../components/settings/SettingsNotice'
import ChoiceGroup from '../../../components/settings/ChoiceGroup'
import SecretInput from '../../../components/settings/SecretInput'
import SettingsStatusBadge, {
  type SettingStatus,
} from '../../../components/settings/StatusBadge'
import {
  useSettings,
  type AnthropicMethod,
  type ClaudeAccountInfo,
  type ClaudeLoginState,
} from '../SettingsContext'
import { ApiError, jsonRequest, requestJson } from '../../../lib/http'
import { evaluateReadiness } from '../readiness'

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

function AccountFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-overlay/40 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-[0.16em] text-fg-subtle">{label}</div>
      <div className="mt-1 text-sm text-fg">{value}</div>
    </div>
  )
}

interface LlmProviderSectionProps {
  /** When true, renders without the SettingsSection card (used inside the wizard). */
  embedded?: boolean
  /** Called once Claude is connected (wizard advances to next step). */
  onConnected?: () => void
}

export default function LlmProviderSection({ embedded = false, onConnected }: LlmProviderSectionProps) {
  const {
    draft,
    setDraft,
    claudeLogin,
    claudeLoginAccount,
    claudeLoginReady,
    setClaudeLogin,
    setClaudeLoginAccount,
  } = useSettings()
  const readiness = evaluateReadiness({ draft, claudeLogin, claudeLoginAccount }).byId['llm-provider']

  const [connecting, setConnecting] = useState(false)
  const [submittingCallback, setSubmittingCallback] = useState(false)
  const [callbackInput, setCallbackInput] = useState('')
  const [callbackState, setCallbackState] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [oauthGenerating, setOauthGenerating] = useState(false)
  const [oauthStatus, setOauthStatus] = useState<string | null>(null)
  const [oauthAuthUrl, setOauthAuthUrl] = useState<string | null>(null)
  const [oauthCliMissing, setOauthCliMissing] = useState(false)

  const effectiveAccount = claudeLogin.account ?? claudeLoginAccount
  const claudeLoginUrl = claudeLogin.automaticUrl ?? claudeLogin.manualUrl ?? null

  function setMethod(method: AnthropicMethod) {
    setDraft('anthropicMethod', method)
    setError(null)
    setOauthStatus(null)
    setOauthAuthUrl(null)
  }

  async function startClaudeLogin() {
    setConnecting(true)
    setError(null)
    try {
      const data = await requestJson<ClaudeLoginState>('/config/anthropic/claude-login/start', { method: 'POST' })
      setClaudeLogin(data)
      if (data.account) setClaudeLoginAccount(data.account)
      setDraft('anthropicMethod', 'claudeLogin')
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
      if (data.account) setClaudeLoginAccount(data.account)
      if (data.status !== 'connected') throw new Error(data.error ?? 'Claude login did not complete.')
      setDraft('anthropicMethod', 'claudeLogin')
      setCallbackInput('')
      setCallbackState('')
      onConnected?.()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setSubmittingCallback(false)
    }
  }

  async function generateOauthToken() {
    setOauthGenerating(true)
    setOauthStatus('Launching Claude Code login. Complete sign-in in your browser…')
    setOauthAuthUrl(null)
    setError(null)
    try {
      const data = await requestJson<LegacyOauthResponse>('/config/anthropic/generate-oauth-token', { method: 'POST' })
      if (data.authUrl) setOauthAuthUrl(data.authUrl)
      if (data.token) {
        setDraft('oauthToken', data.token)
        setDraft('anthropicMethod', 'oauth')
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

  const body = (
    <>
      <Field label="Authentication method">
        <ChoiceGroup<AnthropicMethod>
          name="anthropic-method"
          value={draft.anthropicMethod}
          onChange={setMethod}
          options={ANTHROPIC_OPTIONS}
          cols={3}
        />
      </Field>

      {error ? <SettingsNotice tone="danger">{error}</SettingsNotice> : null}

      {draft.anthropicMethod === 'claudeLogin' ? (
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
            <Button type="button" size="sm" onClick={() => void startClaudeLogin()} disabled={connecting}>
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

      {draft.anthropicMethod === 'apiKey' ? (
        <Field label="API key" required hint="Anthropic API key from console.anthropic.com.">
          <SecretInput
            value={draft.apiKey}
            onChange={event => setDraft('apiKey', event.target.value)}
            placeholder="sk-ant-…"
          />
        </Field>
      ) : null}

      {draft.anthropicMethod === 'oauth' ? (
        <div className="space-y-4">
          <Field label="OAuth token" required hint="Legacy fallback only. Prefer Claude login whenever possible.">
            <SecretInput
              value={draft.oauthToken}
              onChange={event => setDraft('oauthToken', event.target.value)}
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
    </>
  )

  if (embedded) {
    return <div className="space-y-5">{body}</div>
  }

  return (
    <SettingsSection
      title="LLM provider"
      description="Authenticate the runner against the model that drives every job."
      required
      status={readiness.status}
      statusLabel={readiness.label}
    >
      {body as ReactNode}
    </SettingsSection>
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
