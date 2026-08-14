import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KeyRound } from 'lucide-react'
import { Button } from '../ui/button'
import Field from '../forms/field'
import SecretInput from '../settings/SecretInput'
import SettingsNotice from '../settings/SettingsNotice'
import SettingsStatusBadge from '../settings/StatusBadge'
import { Input } from '../ui/input'
import { ApiError, jsonRequest, requestJson } from '../../lib/http'
import type {
  DetectCandidatePreview,
  NormalizedOAuthStatus,
  PluginAuthFieldDescriptor,
  PluginAuthMethodDescriptor,
  PluginCatalogEntry,
} from '../../lib/plugin-catalog-types'
import {
  activeFormFields,
  pickDefaultAuthMethod,
} from '../../lib/plugin-catalog-types'
import type { TestResult } from './wizard-state'

/**
 * Does this status mean "you must do something outside Coro first" rather
 * than "the attempt failed"? Driven by the plugin's declared `code`, never by
 * matching message text — the panel must stay provider-agnostic.
 */
function isSetupRequired(status: Pick<NormalizedOAuthStatus, 'code' | 'available'>): boolean {
  return status.code === 'setup_required' || status.available === false
}

function applyConfigPatch(
  patch: Record<string, unknown>,
  onChange: (key: string, value: unknown) => void,
): void {
  for (const [key, value] of Object.entries(patch)) {
    onChange(key, value)
  }
}

function applyAccountPath(
  path: string,
  label: string,
  draftConfig: Record<string, unknown>,
  onChange: (key: string, value: unknown) => void,
): void {
  const parts = path.split('.')
  if (parts.length === 1) {
    onChange(parts[0]!, label)
    return
  }
  const [root, leaf] = [parts[0]!, parts[parts.length - 1]!]
  const current =
    typeof draftConfig[root] === 'object' && draftConfig[root] !== null
      ? (draftConfig[root] as Record<string, unknown>)
      : {}
  onChange(root, { ...current, [leaf]: label })
}

function hasAccountPath(draftConfig: Record<string, unknown>, path: string): boolean {
  const parts = path.split('.')
  let current: unknown = draftConfig
  for (const part of parts) {
    if (typeof current !== 'object' || current === null) return false
    current = (current as Record<string, unknown>)[part]
  }
  return typeof current === 'string' && current.length > 0
}

function selectAuthMethod(
  method: PluginAuthMethodDescriptor,
  setSelectedMethodId: (id: string) => void,
  onChange: (key: string, value: unknown) => void,
): void {
  setSelectedMethodId(method.id)
  if ((method.kind === 'form' || method.kind === 'oauth') && method.configOnSelect) {
    applyConfigPatch(method.configOnSelect, onChange)
  }
}

function useStableOnChange(onChange: (key: string, value: unknown) => void) {
  const ref = useRef(onChange)
  ref.current = onChange
  return useCallback((key: string, value: unknown) => {
    ref.current(key, value)
  }, [])
}

/**
 * Fingerprint of a draft config, used as part of the auto-verify key so that
 * editing a field after a step has passed re-runs the probe instead of
 * leaving the step stuck on a result for values the user has since changed.
 * Hashed rather than concatenated so credentials aren't duplicated into a
 * long-lived string.
 */
function configSignature(config: Record<string, unknown>): string {
  const serialized = Object.keys(config)
    .sort()
    .map(key => `${key}=${String(config[key] ?? '')}`)
    .join('|')
  let hash = 5381
  for (let i = 0; i < serialized.length; i += 1) {
    hash = ((hash << 5) + hash + serialized.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(36)
}

/** How long field edits must settle before a re-verify fires. */
const VERIFY_DEBOUNCE_MS = 800

/** When credentials look ready (OAuth connected, form filled), run probe once. */
function useAutoVerifyWhenReady(
  autoVerifyWhenReady: boolean | undefined,
  ready: boolean,
  verifyKey: string,
  onVerify: () => Promise<void>,
): void {
  const onVerifyRef = useRef(onVerify)
  onVerifyRef.current = onVerify
  const prevReadyRef = useRef(false)
  const lastVerifiedKeyRef = useRef<string | null>(null)

  useEffect(() => {
    const becameReady = ready && !prevReadyRef.current
    prevReadyRef.current = ready
    if (!ready) {
      lastVerifiedKeyRef.current = null
    }
    if (!autoVerifyWhenReady || !ready) return
    if (!becameReady && lastVerifiedKeyRef.current === verifyKey) return
    // `verifyKey` carries the field values, so it changes on every keystroke
    // once the form is complete. Settle first — the probe is a real network
    // round-trip against the provider.
    const delay = becameReady ? 0 : VERIFY_DEBOUNCE_MS
    const timer = window.setTimeout(() => {
      lastVerifiedKeyRef.current = verifyKey
      void onVerifyRef.current()
    }, delay)
    return () => window.clearTimeout(timer)
  }, [autoVerifyWhenReady, ready, verifyKey])
}

/** Apply manifest `configOnSelect` once per method — avoids render loops. */
function useApplyConfigOnSelect(
  methodId: string,
  configOnSelect: Record<string, unknown> | undefined,
  onChange: (key: string, value: unknown) => void,
): void {
  const appliedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!configOnSelect) return
    if (appliedRef.current === methodId) return
    appliedRef.current = methodId
    applyConfigPatch(configOnSelect, onChange)
  }, [methodId, configOnSelect, onChange])
}

interface GenericAuthPanelProps {
  entry: PluginCatalogEntry
  draftConfig: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  onTestResult: (result: TestResult) => void
  onBeginTest?: () => void
  /** When applying detected credentials, merge owner overrides etc. */
  detectOverrides?: Record<string, unknown>
  /** Wizard: probe automatically when auth looks ready (enables Continue). */
  autoVerifyWhenReady?: boolean
}

export default function GenericAuthPanel({
  entry,
  draftConfig,
  onChange,
  onTestResult,
  onBeginTest,
  detectOverrides,
  autoVerifyWhenReady,
}: GenericAuthPanelProps) {
  const stableOnChange = useStableOnChange(onChange)
  const methods = entry.authMethods ?? []
  const defaultMethod = useMemo(() => pickDefaultAuthMethod(methods), [methods])
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(
    defaultMethod?.id ?? null,
  )
  const selectedMethod = methods.find(m => m.id === selectedMethodId) ?? defaultMethod
  const appliedDefaultRef = useRef<string | null>(null)

  useEffect(() => {
    if (!selectedMethodId && defaultMethod) {
      setSelectedMethodId(defaultMethod.id)
    }
  }, [defaultMethod, selectedMethodId])

  useEffect(() => {
    if (!defaultMethod || selectedMethodId !== defaultMethod.id) return
    if (appliedDefaultRef.current === defaultMethod.id) return
    if (
      (defaultMethod.kind === 'form' || defaultMethod.kind === 'oauth') &&
      defaultMethod.configOnSelect
    ) {
      applyConfigPatch(defaultMethod.configOnSelect, stableOnChange)
    }
    appliedDefaultRef.current = defaultMethod.id
  }, [defaultMethod, selectedMethodId, stableOnChange])

  if (methods.length === 0) {
    return (
      <AuthTestButton
        pluginId={entry.id}
        draftConfig={draftConfig}
        canTest
        autoVerifyWhenReady={autoVerifyWhenReady}
        onTestResult={onTestResult}
        onBeginTest={onBeginTest}
      />
    )
  }

  return (
    <div className="space-y-3.5 rounded-2xl border border-line bg-overlay/30 p-4">
      {methods.length > 1 ? (
        <div className="space-y-2">
          <span className="text-sm font-medium text-fg">How should we authenticate?</span>
          <div className="inline-flex flex-wrap gap-1 rounded-xl border border-line bg-canvas/40 p-1 text-sm">
            {methods.map(method => (
              <button
                key={method.id}
                type="button"
                onClick={() => selectAuthMethod(method, setSelectedMethodId, stableOnChange)}
                className={
                  selectedMethod?.id === method.id
                    ? 'inline-flex items-center gap-2 rounded-lg bg-accent-500/15 px-3 py-1.5 font-medium text-accent-200 ring-1 ring-accent-500/30'
                    : 'inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-fg-muted hover:text-fg'
                }
              >
                {method.label}
                {method.recommended ? (
                  <span className="rounded-full bg-overlay/60 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.16em] text-fg-subtle">
                    Recommended
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {selectedMethod?.kind === 'oauth' ? (
        <OAuthAuthMethod
          method={selectedMethod}
          draftConfig={draftConfig}
          onChange={stableOnChange}
          pluginId={entry.id}
          autoVerifyWhenReady={autoVerifyWhenReady}
          onTestResult={onTestResult}
          onBeginTest={onBeginTest}
        />
      ) : null}

      {selectedMethod?.kind === 'detect' ? (
        <DetectAuthMethod
          pluginId={entry.id}
          method={selectedMethod}
          draftConfig={draftConfig}
          onChange={stableOnChange}
          overrides={detectOverrides}
          onTestResult={onTestResult}
          onBeginTest={onBeginTest}
        />
      ) : null}

      {selectedMethod?.kind === 'form' ? (
        <FormAuthMethod
          pluginId={entry.id}
          method={selectedMethod}
          fields={activeFormFields(selectedMethod)}
          draftConfig={draftConfig}
          onChange={stableOnChange}
          autoVerifyWhenReady={autoVerifyWhenReady}
          onTestResult={onTestResult}
          onBeginTest={onBeginTest}
        />
      ) : null}
    </div>
  )
}

function FormAuthMethod({
  pluginId,
  method,
  fields,
  draftConfig,
  onChange,
  autoVerifyWhenReady,
  onTestResult,
  onBeginTest,
}: {
  pluginId: string
  method: Extract<PluginAuthMethodDescriptor, { kind: 'form' }>
  fields: PluginAuthFieldDescriptor[]
  draftConfig: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  autoVerifyWhenReady?: boolean
  onTestResult: (result: TestResult) => void
  onBeginTest?: () => void
}) {
  useApplyConfigOnSelect(method.id, method.configOnSelect, onChange)

  const requiredFilled =
    fields.filter(f => f.required).every(f => {
      const v = draftConfig[f.key]
      return typeof v === 'string' && v.length > 0
    })
  const canTest = fields.length === 0 || requiredFilled

  return (
    <div className="space-y-3">
      {fields.length > 0 ? (
        <div className="space-y-3">
          {fields.map(field => (
            <Field key={field.key} label={field.label} hint={field.hint} required={field.required}>
              {field.kind === 'secret' ? (
                <SecretInput
                  value={typeof draftConfig[field.key] === 'string' ? (draftConfig[field.key] as string) : ''}
                  placeholder={field.placeholder}
                  onChange={event => onChange(field.key, event.target.value)}
                />
              ) : (
                <Input
                  type={field.kind === 'url' ? 'url' : 'text'}
                  value={typeof draftConfig[field.key] === 'string' ? (draftConfig[field.key] as string) : ''}
                  placeholder={field.placeholder}
                  onChange={event => onChange(field.key, event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </Field>
          ))}
        </div>
      ) : (
        <p className="text-[12px] text-fg-subtle">No credentials required — click Test to enable.</p>
      )}
      <AuthTestButton
        pluginId={pluginId}
        draftConfig={draftConfig}
        canTest={canTest}
        autoVerifyWhenReady={autoVerifyWhenReady}
        onTestResult={onTestResult}
        onBeginTest={onBeginTest}
      />
    </div>
  )
}

function OAuthAuthMethod({
  method,
  draftConfig,
  onChange,
  pluginId,
  autoVerifyWhenReady,
  onTestResult,
  onBeginTest,
}: {
  method: Extract<PluginAuthMethodDescriptor, { kind: 'oauth' }>
  draftConfig: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  pluginId: string
  autoVerifyWhenReady?: boolean
  onTestResult: (result: TestResult) => void
  onBeginTest?: () => void
}) {
  const [oauth, setOauth] = useState<NormalizedOAuthStatus>({ state: 'idle' })
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [availabilityChecked, setAvailabilityChecked] = useState(false)

  const clientIdKey = method.clientIdConfigKey ?? 'oauthClientId'
  const oauthClientId =
    typeof draftConfig[clientIdKey] === 'string' ? (draftConfig[clientIdKey] as string) : ''
  const supportsByoClientId = Boolean(method.clientIdConfigKey)
  const oauthAvailable =
    oauth.available !== false || (supportsByoClientId && oauthClientId.trim().length > 0)
  const setupMessage = oauth.setupHint ?? oauth.message
  const showSetupNotice =
    !oauthAvailable && availabilityChecked && Boolean(setupMessage)
  const showClientIdField = supportsByoClientId && showSetupNotice
  const isSetupError = oauth.state === 'error' && isSetupRequired(oauth)

  useEffect(() => {
    let cancelled = false
    void requestJson<NormalizedOAuthStatus>(method.statusPath)
      .then(data => {
        if (cancelled) return
        setOauth(data)
        setAvailabilityChecked(true)
      })
      .catch(() => {
        if (!cancelled) setAvailabilityChecked(true)
      })
    return () => {
      cancelled = true
    }
  }, [method.statusPath])

  useApplyConfigOnSelect(method.id, method.configOnSelect, onChange)

  useEffect(() => {
    if (
      method.successAccountPath &&
      hasAccountPath(draftConfig, method.successAccountPath) &&
      oauth.state === 'idle'
    ) {
      const parts = method.successAccountPath.split('.')
      let current: unknown = draftConfig
      for (const part of parts) {
        current = (current as Record<string, unknown>)?.[part]
      }
      if (typeof current === 'string') {
        setOauth({ state: 'success', account: { label: current } })
      }
    }
  }, [draftConfig, method.successAccountPath, oauth.state])

  useEffect(() => {
    if (oauth.state !== 'pending') return
    // The poll outlives the panel when the user leaves the step mid-flow, so
    // every write back into React state is gated on still being mounted.
    let cancelled = false
    const timer = window.setInterval(async () => {
      try {
        const data = await requestJson<NormalizedOAuthStatus>(method.statusPath)
        if (cancelled) return
        setOauth(data)
        if (data.state === 'success') {
          if (method.configOnSelect) {
            applyConfigPatch(method.configOnSelect, onChange)
          }
          if (data.account?.label && method.successAccountPath) {
            applyAccountPath(method.successAccountPath, data.account.label, draftConfig, onChange)
          }
        }
      } catch {
        /* soft fail */
      }
    }, 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [oauth.state, method.statusPath, method.configOnSelect, method.successAccountPath, draftConfig, onChange])

  const ready =
    oauth.state === 'success' ||
    (method.successAccountPath ? hasAccountPath(draftConfig, method.successAccountPath) : false)

  const runTest = useCallback(async () => {
    setTesting(true)
    onBeginTest?.()
    try {
      const result = await requestJson<{ ok: boolean; message?: string; hint?: string; checks?: TestResult['checks'] }>(
        `/test/plugin/${encodeURIComponent(pluginId)}`,
        jsonRequest({ config: draftConfig }, { method: 'POST' }),
      )
      onTestResult({
        ok: result.ok,
        message: result.message ?? (result.ok ? 'Authenticated.' : 'Test failed.'),
        ...(result.hint ? { hint: result.hint } : {}),
        ...(result.checks ? { checks: result.checks } : {}),
      })
    } catch (err) {
      onTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setTesting(false)
    }
  }, [draftConfig, onBeginTest, onTestResult, pluginId])

  useAutoVerifyWhenReady(
    autoVerifyWhenReady,
    ready,
    `${pluginId}:${method.id}:${configSignature(draftConfig)}`,
    runTest,
  )

  async function startOAuth(force = false) {
    setConnecting(true)
    setError(null)
    try {
      const payload: Record<string, unknown> = {}
      if (force) payload['force'] = true
      if (supportsByoClientId && oauthClientId.trim()) {
        payload['oauthClientId'] = oauthClientId.trim()
      }
      const data = await requestJson<NormalizedOAuthStatus>(
        method.startPath,
        jsonRequest(payload, { method: 'POST' }),
      )
      setOauth(data)
      if (data.state === 'pending' && data.authorizeUrl) {
        window.open(data.authorizeUrl, '_blank', 'noopener,noreferrer')
      }
      if (data.state === 'error') {
        if (isSetupRequired(data)) {
          setError(data.setupHint ?? data.message ?? 'This sign-in needs setup first.')
          setOauth(prev => ({
            ...prev,
            state: 'idle',
            available: false,
            ...(data.code ? { code: data.code } : {}),
            ...(data.setupHint ? { setupHint: data.setupHint } : {}),
            ...(data.message ? { message: data.message } : {}),
          }))
          return
        }
        throw new Error(data.message ?? 'Sign-in failed to start.')
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setConnecting(false)
    }
  }

  const statusBadge =
    oauth.state === 'success' || ready
      ? { status: 'ok' as const, label: 'Connected' }
      : oauth.state === 'pending'
        ? { status: 'pending' as const, label: oauth.userCode ? 'Enter code in browser' : 'Waiting for browser…' }
        : showSetupNotice
          ? { status: 'unset' as const, label: 'Setup required' }
          : oauth.state === 'error' && !isSetupError
            ? { status: 'error' as const, label: 'Failed' }
            : { status: 'unset' as const, label: 'Not connected' }

  const displayError = error && !(showSetupNotice && error === setupMessage) ? error : null

  return (
    <div className="space-y-3">
      {showSetupNotice ? (
        <SettingsNotice tone="warning">
          {setupMessage}
          {oauth.callbackUrl ? (
            <>
              {' '}
              Register callback URL{' '}
              <span className="font-mono text-fg">{oauth.callbackUrl}</span> in your OAuth app.
            </>
          ) : null}
        </SettingsNotice>
      ) : null}
      {showClientIdField ? (
        <Field
          label="OAuth client ID"
          hint="From the OAuth app you registered with this provider."
        >
          <Input
            value={oauthClientId}
            onChange={event => onChange(clientIdKey, event.target.value)}
            placeholder="Your OAuth client ID"
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      ) : null}
      {oauth.state === 'pending' && oauth.userCode ? (
        <SettingsNotice tone="accent">
          Enter code{' '}
          <span className="font-mono font-semibold text-fg">{oauth.userCode}</span> at{' '}
          {oauth.authorizeUrl ? (
            <a
              href={oauth.authorizeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-300 underline underline-offset-2"
            >
              {oauth.authorizeUrl}
            </a>
          ) : (
            'the verification page'
          )}
          .
        </SettingsNotice>
      ) : null}
      {displayError ? (
        <SettingsNotice tone={oauthAvailable ? 'danger' : 'warning'}>{displayError}</SettingsNotice>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-canvas/30 px-3 py-2.5">
        <div className="flex items-center gap-3 min-w-0">
          <SettingsStatusBadge status={statusBadge.status} label={statusBadge.label} />
          {oauth.account?.label ? (
            <span className="truncate text-sm text-fg-muted">{oauth.account.label}</span>
          ) : null}
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => void startOAuth(ready)}
          disabled={connecting || (showClientIdField && !oauthClientId.trim())}
        >
          {connecting ? 'Starting…' : ready ? 'Reconnect' : method.label}
        </Button>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => void runTest()} disabled={!ready || testing}>
          <KeyRound />
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
      </div>
    </div>
  )
}

function DetectAuthMethod({
  pluginId,
  method,
  draftConfig,
  onChange,
  overrides,
  onTestResult,
  onBeginTest,
}: {
  pluginId: string
  method: Extract<PluginAuthMethodDescriptor, { kind: 'detect' }>
  draftConfig: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  overrides?: Record<string, unknown>
  onTestResult: (result: TestResult) => void
  onBeginTest?: () => void
}) {
  const [candidates, setCandidates] = useState<DetectCandidatePreview[]>([])
  const [loading, setLoading] = useState(true)
  const [scanError, setScanError] = useState<string | null>(null)
  const [applying, setApplying] = useState<string | null>(null)
  // Applying a candidate writes its account into the draft, so the override
  // field can't distinguish "what the last click filled in" from "what the
  // user typed". Only a real edit should win over the candidate's own account.
  const [accountEdited, setAccountEdited] = useState(false)

  useEffect(() => {
    let cancelled = false
    void requestJson<{ candidates: DetectCandidatePreview[] }>(
      `/config/plugins/${encodeURIComponent(pluginId)}/auth/detect`,
      { method: 'POST' },
    )
      .then(res => {
        if (cancelled) return
        setCandidates(res.candidates)
        setScanError(null)
      })
      .catch(err => {
        // A failed scan is not the same as "nothing found" — saying so would
        // send the user to type a token they don't need.
        if (cancelled) return
        setCandidates([])
        setScanError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [pluginId])

  async function applyCandidate(candidate: DetectCandidatePreview) {
    setApplying(candidate.id)
    onBeginTest?.()
    const accountKey = method.accountConfigKey
    try {
      // Only the one field the detect UI exposes for editing may override the
      // candidate. Sweeping the whole draft in would let a stale (and
      // possibly masked) token from a previous provider selection replace the
      // credential the user just picked.
      const mergedOverrides = { ...overrides }
      if (accountKey && accountEdited) {
        const edited = draftConfig[accountKey]
        if (typeof edited === 'string' && edited.trim()) {
          mergedOverrides[accountKey] = edited.trim()
        }
      }
      const result = await requestJson<{ ok: boolean; message?: string; hint?: string; checks?: TestResult['checks'] }>(
        `/config/plugins/${encodeURIComponent(pluginId)}/auth/detect/apply`,
        jsonRequest({ candidateId: candidate.id, overrides: mergedOverrides }, { method: 'POST' }),
      )
      if (result.ok) {
        if (accountKey && candidate.accountHint) {
          onChange(accountKey, candidate.accountHint)
        }
      }
      onTestResult({
        ok: result.ok,
        message: result.message ?? (result.ok ? 'Credentials applied.' : 'Apply failed.'),
        ...(result.hint ? { hint: result.hint } : {}),
        ...(result.checks ? { checks: result.checks } : {}),
      })
    } catch (err) {
      onTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setApplying(null)
    }
  }

  if (loading) return <p className="text-sm text-fg-muted">Scanning for existing credentials…</p>
  if (scanError) {
    return (
      <p className="text-[12px] text-danger-300">
        Could not scan this machine for credentials: {scanError}
      </p>
    )
  }
  if (candidates.length === 0) {
    return (
      <p className="text-[12px] text-fg-subtle">
        No local credentials found for {method.label.toLowerCase()}.
      </p>
    )
  }

  return (
    <div className="space-y-2 rounded-xl border border-accent-500/25 bg-accent-500/5 p-3">
      <div className="text-sm font-medium text-fg">
        {candidates.length === 1
          ? 'Found existing credentials'
          : `Found ${candidates.length} accounts — pick the one to use`}
      </div>
      {candidates.map(candidate => (
        <div
          key={candidate.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-canvas/40 px-3 py-2"
        >
          <div className="min-w-0 text-sm">
            <div className="font-medium text-fg">{candidate.sourceLabel}</div>
            {candidate.accountHint ? (
              <div className="text-fg-muted">{candidate.accountHint}</div>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            disabled={applying === candidate.id}
            onClick={() => void applyCandidate(candidate)}
          >
            {applying === candidate.id ? 'Applying…' : 'Use this'}
          </Button>
        </div>
      ))}
      {method.accountConfigKey ? (
        <Field
          label="Owner / organisation"
          hint="Org-owned repos are common — override the detected personal login if needed."
        >
          <Input
            value={
              typeof draftConfig[method.accountConfigKey] === 'string'
                ? (draftConfig[method.accountConfigKey] as string)
                : ''
            }
            onChange={event => {
              setAccountEdited(true)
              onChange(method.accountConfigKey!, event.target.value)
            }}
            autoComplete="off"
          />
        </Field>
      ) : null}
    </div>
  )
}

function AuthTestButton({
  pluginId,
  draftConfig,
  canTest,
  autoVerifyWhenReady,
  onTestResult,
  onBeginTest,
}: {
  pluginId: string
  draftConfig: Record<string, unknown>
  canTest: boolean
  autoVerifyWhenReady?: boolean
  onTestResult: (result: TestResult) => void
  onBeginTest?: () => void
}) {
  const [testing, setTesting] = useState(false)

  const runTest = useCallback(async () => {
    if (!canTest) return
    setTesting(true)
    onBeginTest?.()
    try {
      const result = await requestJson<{ ok: boolean; message?: string; hint?: string; checks?: TestResult['checks'] }>(
        `/test/plugin/${encodeURIComponent(pluginId)}`,
        jsonRequest({ config: draftConfig }, { method: 'POST' }),
      )
      onTestResult({
        ok: result.ok,
        message: result.message ?? (result.ok ? 'Authenticated.' : 'Test failed.'),
        ...(result.hint ? { hint: result.hint } : {}),
        ...(result.checks ? { checks: result.checks } : {}),
      })
    } catch (err) {
      onTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setTesting(false)
    }
  }, [canTest, draftConfig, onBeginTest, onTestResult, pluginId])

  useAutoVerifyWhenReady(
    autoVerifyWhenReady,
    canTest,
    `${pluginId}:${configSignature(draftConfig)}`,
    runTest,
  )

  return (
    <div className="flex items-center justify-end gap-2 pt-1">
      <Button type="button" variant="secondary" onClick={() => void runTest()} disabled={!canTest || testing}>
        <KeyRound />
        {testing ? 'Testing…' : 'Test connection'}
      </Button>
    </div>
  )
}
