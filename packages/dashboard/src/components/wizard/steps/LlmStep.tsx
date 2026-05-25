import { useEffect, useState } from 'react'
import { KeyRound, Plug } from 'lucide-react'
import StepShell from './components/StepShell'
import ProviderCard from './components/ProviderCard'
import ProviderConfigForm from './components/ProviderConfigForm'
import LiveTestPanel from './components/LiveTestPanel'
import { Button } from '../../ui/button'
import SecretInput from '../../settings/SecretInput'
import SettingsNotice from '../../settings/SettingsNotice'
import SettingsStatusBadge from '../../settings/StatusBadge'
import Field from '../../forms/field'
import { ApiError, jsonRequest, requestJson } from '../../../lib/http'
import { getProvidersForStep } from '../provider-catalog'
import type { StepState, WizardAction } from '../wizard-state'

interface LlmStepProps {
  state: StepState
  dispatch: (action: WizardAction) => void
  onOpenDrawer: () => void
}

type AnthropicMethod = 'apiKey' | 'claudeLogin' | 'oauth'

interface ClaudeAccountInfo {
  email?: string
  organization?: string
  subscriptionType?: string
}

interface ClaudeLoginState {
  status: 'idle' | 'authorizing' | 'connected' | 'error'
  manualUrl?: string
  automaticUrl?: string
  account?: ClaudeAccountInfo
  error?: string
}

/**
 * The "pick your model" step. Shows Anthropic + OpenAI as radio
 * cards; Anthropic has a bespoke Claude-login surface (one click)
 * with API-key fallback; OpenAI is a single API-key field. Both
 * paths funnel through `POST /test/llm` for live verification
 * before the user can press Continue.
 */
export default function LlmStep({ state, dispatch, onOpenDrawer }: LlmStepProps) {
  const providers = getProvidersForStep('llm')
  const selectedId = state.selectedProviderId
  const selected = providers.find(p => p.id === selectedId)

  return (
    <StepShell
      eyebrow="Step 1 of 3"
      title="Which model should power Coro?"
      description="Coro uses an LLM to plan, write code, and review changes. Pick one to start — you can switch or add more later in Settings."
    >
      <div className="space-y-3">
        {providers.map(provider => (
          <ProviderCard
            key={provider.id}
            pluginId={provider.id}
            title={provider.title}
            subtitle={provider.subtitle}
            recommended={provider.recommended}
            selected={selectedId === provider.id}
            onSelect={() =>
              dispatch({ type: 'selectProvider', step: 'llm', providerId: provider.id })
            }
          />
        ))}

        <button
          type="button"
          onClick={onOpenDrawer}
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-transparent px-4 py-3 text-sm text-fg-muted hover:border-accent-500/30 hover:bg-overlay/40 hover:text-fg"
        >
          <Plug className="size-4" />
          Need something else? Browse custom executor plugins
        </button>
      </div>

      {selected && selected.authMode === 'anthropic' ? (
        <AnthropicAuth state={state} dispatch={dispatch} />
      ) : null}

      {selected && selected.authMode === 'apiKey' ? (
        <OpenAiAuth state={state} dispatch={dispatch} provider={selected} />
      ) : null}

      <LiveTestPanel status={state.status} result={state.lastResult} />
    </StepShell>
  )
}

// ── Anthropic surface ──────────────────────────────────────────────────────
//
// Custom path because Anthropic has Claude login (OAuth + persisted
// session managed by Claude Code) as the recommended option. The
// API-key fallback is a single secret field. We keep the legacy
// OAuth token surface in the full Settings page — it's a developer
// escape hatch, not a first-run choice.

function AnthropicAuth({
  state,
  dispatch,
}: {
  state: StepState
  dispatch: (action: WizardAction) => void
}) {
  const cfg = state.draftConfig as {
    method?: AnthropicMethod
    apiKey?: string
    account?: ClaudeAccountInfo
  }
  const method: AnthropicMethod = cfg.method ?? 'claudeLogin'
  const apiKey = cfg.apiKey ?? ''
  const account = cfg.account

  const [claudeLogin, setClaudeLogin] = useState<ClaudeLoginState>({ status: 'idle' })
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  // Initial mount — bootstrap from any persisted Claude account.
  useEffect(() => {
    if (account && claudeLogin.status === 'idle') {
      setClaudeLogin({ status: 'connected', account })
    }
  }, [account, claudeLogin.status])

  // Poll while login is mid-flight.
  useEffect(() => {
    if (claudeLogin.status !== 'authorizing') return
    const timer = window.setInterval(async () => {
      try {
        const data = await requestJson<ClaudeLoginState>('/config/anthropic/claude-login/status')
        if (data.status === 'idle') return
        setClaudeLogin(data)
        if (data.status === 'connected' && data.account) {
          dispatch({ type: 'setField', step: 'llm', key: 'method', value: 'claudeLogin' })
          dispatch({ type: 'setField', step: 'llm', key: 'account', value: data.account })
        }
      } catch {
        // Soft fail — explicit retry button is the recovery path.
      }
    }, 2000)
    return () => window.clearInterval(timer)
  }, [claudeLogin.status, dispatch])

  function setMethod(next: AnthropicMethod) {
    dispatch({ type: 'setField', step: 'llm', key: 'method', value: next })
    setError(null)
  }

  async function startClaudeLogin() {
    setConnecting(true)
    setError(null)
    try {
      const data = await requestJson<ClaudeLoginState>('/config/anthropic/claude-login/start', {
        method: 'POST',
      })
      setClaudeLogin(data)
      dispatch({ type: 'setField', step: 'llm', key: 'method', value: 'claudeLogin' })
      if (data.account) dispatch({ type: 'setField', step: 'llm', key: 'account', value: data.account })
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

  async function runTest() {
    setTesting(true)
    dispatch({ type: 'beginTest', step: 'llm' })
    try {
      const result = await requestJson<{ ok: boolean; message?: string; hint?: string }>(
        '/test/llm',
        jsonRequest(
          { provider: 'anthropic', config: state.draftConfig },
          { method: 'POST' },
        ),
      )
      dispatch({
        type: 'testResult',
        step: 'llm',
        result: {
          ok: result.ok,
          message: result.message ?? (result.ok ? 'Authenticated.' : 'Test failed.'),
          ...(result.hint ? { hint: result.hint } : {}),
        },
      })
    } catch (err) {
      dispatch({
        type: 'testResult',
        step: 'llm',
        result: {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        },
      })
    } finally {
      setTesting(false)
    }
  }

  const claudeReady = claudeLogin.status === 'connected' || !!account
  const canTest =
    method === 'claudeLogin'
      ? claudeReady
      : method === 'apiKey'
        ? apiKey.length > 0
        : false

  return (
    <div className="space-y-3.5 rounded-2xl border border-line bg-overlay/30 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-fg">How should we authenticate?</span>
      </div>
      <div className="inline-flex rounded-xl border border-line bg-canvas/40 p-1 text-sm">
        <MethodTab
          active={method === 'claudeLogin'}
          onClick={() => setMethod('claudeLogin')}
          label="Claude login"
          badge="Recommended"
        />
        <MethodTab
          active={method === 'apiKey'}
          onClick={() => setMethod('apiKey')}
          label="API key"
        />
      </div>

      {error ? <SettingsNotice tone="danger">{error}</SettingsNotice> : null}

      {method === 'claudeLogin' ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-canvas/30 px-3 py-2.5">
            <div className="flex items-center gap-3 min-w-0">
              <SettingsStatusBadge
                status={
                  claudeLogin.status === 'connected' || account
                    ? 'ok'
                    : claudeLogin.status === 'authorizing'
                      ? 'pending'
                      : claudeLogin.status === 'error'
                        ? 'error'
                        : 'unset'
                }
                label={
                  claudeLogin.status === 'connected' || account
                    ? 'Connected'
                    : claudeLogin.status === 'authorizing'
                      ? 'Waiting for browser…'
                      : claudeLogin.status === 'error'
                        ? 'Failed'
                        : 'Not connected'
                }
              />
              {(claudeLogin.account ?? account)?.email ? (
                <span className="truncate text-sm text-fg-muted">
                  {(claudeLogin.account ?? account)?.email}
                </span>
              ) : null}
            </div>
            <Button type="button" size="sm" onClick={() => void startClaudeLogin()} disabled={connecting}>
              {connecting ? 'Starting…' : claudeReady ? 'Reconnect' : 'Connect Claude'}
            </Button>
          </div>
          <p className="text-[12px] text-fg-subtle">
            Uses Claude Code's local login session — no token to manage. Best path for Claude subscribers.
          </p>
        </div>
      ) : (
        <Field label="Anthropic API key" hint="From console.anthropic.com." required>
          <SecretInput
            value={apiKey}
            placeholder="sk-ant-…"
            onChange={event =>
              dispatch({ type: 'setField', step: 'llm', key: 'apiKey', value: event.target.value })
            }
          />
        </Field>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="secondary"
          onClick={() => void runTest()}
          disabled={!canTest || testing}
        >
          <KeyRound />
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
      </div>
    </div>
  )
}

function MethodTab({
  active,
  onClick,
  label,
  badge,
}: {
  active: boolean
  onClick: () => void
  label: string
  badge?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        active
          ? 'inline-flex items-center gap-2 rounded-lg bg-accent-500/15 px-3 py-1.5 font-medium text-accent-200 ring-1 ring-accent-500/30'
          : 'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-fg-muted hover:text-fg'
      }
    >
      {label}
      {badge ? (
        <span className="rounded-full bg-overlay/60 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.16em] text-fg-subtle">
          {badge}
        </span>
      ) : null}
    </button>
  )
}

// ── OpenAI (and any future apiKey-style provider) surface ──────────────────

function OpenAiAuth({
  state,
  dispatch,
  provider,
}: {
  state: StepState
  dispatch: (action: WizardAction) => void
  provider: { id: string; title: string; fields: Array<{ key: string; label: string; hint?: string; placeholder?: string; kind: string; required?: boolean }> }
}) {
  const [testing, setTesting] = useState(false)

  async function runTest() {
    setTesting(true)
    dispatch({ type: 'beginTest', step: 'llm' })
    try {
      const result = await requestJson<{ ok: boolean; message?: string; hint?: string }>(
        '/test/llm',
        jsonRequest(
          { provider: provider.id, config: state.draftConfig },
          { method: 'POST' },
        ),
      )
      dispatch({
        type: 'testResult',
        step: 'llm',
        result: {
          ok: result.ok,
          message: result.message ?? (result.ok ? 'Authenticated.' : 'Test failed.'),
          ...(result.hint ? { hint: result.hint } : {}),
        },
      })
    } catch (err) {
      dispatch({
        type: 'testResult',
        step: 'llm',
        result: {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        },
      })
    } finally {
      setTesting(false)
    }
  }

  const requiredFilled = provider.fields
    .filter(f => f.required)
    .every(f => {
      const v = state.draftConfig[f.key]
      return typeof v === 'string' && v.length > 0
    })

  return (
    <div className="space-y-3">
      <ProviderConfigForm
        provider={provider as never}
        draft={state.draftConfig}
        onChange={(key, value) =>
          dispatch({ type: 'setField', step: 'llm', key, value })
        }
      />
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => void runTest()}
          disabled={!requiredFilled || testing}
        >
          <KeyRound />
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
      </div>
    </div>
  )
}

/**
 * Helper used by the outer SetupWizard to decide whether the LLM
 * step is ready to advance.
 */
export function llmStepCanContinue(state: StepState): boolean {
  return state.status === 'passed' || state.status === 'skipped'
}
