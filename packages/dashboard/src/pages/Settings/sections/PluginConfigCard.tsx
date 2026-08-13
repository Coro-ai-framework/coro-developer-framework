import { useMemo, useState, type ReactNode } from 'react'
import { Input } from '../../../components/ui/input'
import ProviderLogo from '../../../components/settings/ProviderLogo'
import Field from '../../../components/forms/field'
import { Switch } from '../../../components/ui/switch'
import SecretInput from '../../../components/settings/SecretInput'
import SettingsNotice from '../../../components/settings/SettingsNotice'
import TestConnectionButton, {
  type TestConnectionResult,
} from '../../../components/settings/TestConnectionButton'
import { cn } from '../../../lib/utils'
import { toneClasses, type Tone } from '../../../lib/status'
import {
  useSettings,
  type PluginEntry,
  type PluginInstalledEntry,
} from '../SettingsContext'
import GenericAuthPanel from '../../../components/wizard/GenericAuthPanel'
import { useProviderCatalog } from '../../../hooks/useProviderCatalog'
import type { TestResult } from '../../../components/wizard/wizard-state'

// ── JSON-Schema → form field decoder ───────────────────────────────────────
//
// Plugin manifests ship a zod-derived JSON Schema via `manifest.configSchema`.
// We don't want to re-implement a generic schema-driven form library; we
// only need to handle the small subset that plugin configs actually use:
// flat objects of strings (some required, some optional). Everything that
// doesn't match that shape falls back to a plain text input.

interface JsonSchemaProperty {
  type?: string
  description?: string
  title?: string
  default?: unknown
  format?: string
  enum?: unknown[]
}

interface JsonSchemaObject {
  type?: string
  required?: string[]
  properties?: Record<string, JsonSchemaProperty>
}

function isJsonSchemaObject(schema: unknown): schema is JsonSchemaObject {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    !Array.isArray(schema) &&
    ((schema as JsonSchemaObject).properties !== undefined ||
      (schema as JsonSchemaObject).type === 'object')
  )
}

function isSecretFieldName(name: string): boolean {
  return /token|apikey|api_key|password|secret|appPassword/i.test(name)
}

function isUrlFieldName(name: string, prop?: JsonSchemaProperty): boolean {
  if (prop?.format === 'uri' || prop?.format === 'url') return true
  return /url|baseUrl|endpoint|host/i.test(name)
}

function humanLabel(name: string, prop?: JsonSchemaProperty): string {
  if (prop?.title) return prop.title
  // Split camelCase / snake_case into words.
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase())
}

interface DecodedField {
  name: string
  label: string
  hint?: string
  required: boolean
  kind: 'text' | 'secret' | 'url'
  placeholder?: string
}

function decodeSchema(schema: unknown): DecodedField[] {
  if (!isJsonSchemaObject(schema) || !schema.properties) return []
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties).map(([name, prop]) => {
    const kind: DecodedField['kind'] = isSecretFieldName(name)
      ? 'secret'
      : isUrlFieldName(name, prop)
        ? 'url'
        : 'text'
    return {
      name,
      label: humanLabel(name, prop),
      hint: prop.description,
      required: required.has(name),
      kind,
      placeholder: prop.default !== undefined && typeof prop.default !== 'object' ? String(prop.default) : undefined,
    }
  })
}

// ── Card props ─────────────────────────────────────────────────────────────

interface PluginConfigCardProps {
  plugin: PluginEntry
  /**
   * Optional hook for sections that need a "test connection" button.
   * Receives the current draft config; returns a ConnectionResult.
   * Sections wire this to /test/git or /test/tracker for built-in
   * plugins, and skip it for drop-ins (no generic test endpoint yet).
   */
  onTest?: (config: Record<string, unknown>) => Promise<TestConnectionResult>
  /** Optional default-radio for the section (one card per section is the default). */
  defaultControl?: ReactNode
  /** Extra notice slot for cross-plugin guidance (e.g. "reuses GitHub creds"). */
  footerNotice?: ReactNode
  /** Forwarded to a custom panel (if the plugin opts into one). */
  onConnected?: () => void
}

/**
 * Renders one plugin's configuration: header (icon + name + source badge
 * + status pill + Enable switch), schema-driven form, optional Test
 * Connection button, and optional default-control + notice slots.
 *
 * Reads/writes the draft via `useSettings()` so the section just needs
 * to filter the catalogue down to the right plugin set.
 */
export default function PluginConfigCard({
  plugin,
  onTest,
  defaultControl,
  footerNotice,
}: PluginConfigCardProps) {
  const { draft, setPluginField, setPluginEnabled, dirtyPluginIds } = useSettings()
  const { plugins: catalogPlugins } = useProviderCatalog()
  const [authTestResult, setAuthTestResult] = useState<TestResult | null>(null)
  const { manifest, source, configured, active, activationHint } = plugin
  // `entryExists` differentiates "the user has never touched this
  // plugin" from "the user explicitly toggled it off". The runner
  // auto-loads built-in executor plugins (Anthropic / OpenAI) with
  // empty config so their HTTP routes mount on a fresh install — that
  // path leaves `draft.pluginInstalled[id]` undefined, and we use
  // that absence as the signal to render the card collapsed with
  // the Enable switch OFF. Only an explicit `enabled: true` (or a
  // saved entry without the field, for back-compat with pre-Phase-G
  // configs) opens the form.
  const entryExists = manifest.id in draft.pluginInstalled
  const entry: PluginInstalledEntry = entryExists
    ? draft.pluginInstalled[manifest.id]
    : { config: {} }
  const enabled = entryExists && entry.enabled !== false
  const fields = useMemo(() => decodeSchema(manifest.configSchema), [manifest.configSchema])
  const catalogEntry = catalogPlugins?.find(p => p.id === manifest.id)
  const authMethods = catalogEntry?.authMethods ?? []
  const usesAuthPanel = authMethods.length > 0
  const dirty = dirtyPluginIds.has(manifest.id)

  // Required fields filled (vacuously true when the plugin has none).
  // Tracked separately from `hasAnyConfig` because the readiness
  // logic only cares about required fields, but the status pill
  // shouldn't claim "ready to save" when the user has typed nothing.
  const hasRequiredFields = fields.some(f => f.required)
  const allRequiredFilled = fields
    .filter(f => f.required)
    .every(f => {
      const v = entry.config[f.name]
      return typeof v === 'string' ? v.length > 0 : v != null
    })
  // Has the user actually entered anything? Used as the gate for the
  // "ready to save" status pill on plugins whose entire schema is
  // optional (OpenAI's apiKey / baseUrl / organization / project /
  // defaultModel are all optional, so `allRequiredFilled` is
  // vacuously true with the form blank).
  const hasAnyConfigValue = Object.values(entry.config).some(v =>
    typeof v === 'string' ? v.length > 0 : v != null,
  )

  const status: { label: string; tone: Tone } = !enabled
    ? entryExists
      ? { label: 'disabled', tone: 'neutral' }
      : { label: 'not configured', tone: 'neutral' }
    : active && configured
      ? { label: 'active', tone: 'success' }
      : configured
        ? { label: 'configured', tone: 'warning' }
        : allRequiredFilled && (hasRequiredFields || hasAnyConfigValue)
          ? { label: 'ready to save', tone: 'warning' }
          : { label: 'needs setup', tone: 'neutral' }

  function renderFieldInput(field: DecodedField) {
    const value = entry.config[field.name]
    const stringValue = typeof value === 'string' ? value : value == null ? '' : String(value)
    const onChange = (next: string) => setPluginField(manifest.id, field.name, next)
    if (field.kind === 'secret') {
      return (
        <SecretInput
          value={stringValue}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder}
          autoComplete="off"
        />
      )
    }
    return (
      <Input
        type={field.kind === 'url' ? 'url' : 'text'}
        value={stringValue}
        onChange={e => onChange(e.target.value)}
        placeholder={field.placeholder}
        inputMode={field.kind === 'url' ? 'url' : undefined}
      />
    )
  }

  return (
    <div
      className={cn(
        'rounded-2xl border bg-overlay/40 px-4 py-4 transition-colors',
        dirty ? 'border-accent-400/50' : 'border-line',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ProviderLogo pluginId={manifest.id} size={20} />
            <div className="text-[15px] font-medium text-fg">{manifest.displayName}</div>
            <span className="font-mono text-[11px] text-fg-subtle">{manifest.id}</span>
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em]',
                source === 'dropin'
                  ? 'border-accent-400/40 bg-accent-500/10 text-accent-200'
                  : 'border-line bg-overlay/60 text-fg-muted',
              )}
            >
              {source === 'dropin' ? 'drop-in' : 'built in'}
            </span>
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em]',
                toneClasses(status.tone),
              )}
            >
              {status.label}
            </span>
            {dirty ? (
              <span className="rounded-full border border-accent-400/50 bg-accent-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-accent-200">
                unsaved
              </span>
            ) : null}
          </div>
          <div className="mt-1 text-[12px] text-fg-muted">
            v{manifest.version} · kind <span className="font-mono text-fg">{manifest.kind}</span>
          </div>
          {activationHint && !configured ? (
            <div className="mt-2 text-[12px] leading-5 text-fg-muted">{activationHint}</div>
          ) : null}
        </div>

        <label className="flex items-center gap-2 text-[12px] text-fg-muted">
          <span>Enabled</span>
          <Switch
            checked={enabled}
            onCheckedChange={next => setPluginEnabled(manifest.id, next)}
            ariaLabel={`Enable ${manifest.displayName}`}
            size="sm"
          />
        </label>
      </div>

      {/* Body collapses when the plugin is disabled — fewer pixels, less
          cognitive load when the user has many plugins installed. The
          header (with the Enable switch) stays visible so it's a
          one-click expand. */}
      {enabled ? (
        <>
          {usesAuthPanel && catalogEntry ? (
            <div className="mt-4 space-y-3">
              <GenericAuthPanel
                entry={catalogEntry}
                draftConfig={entry.config}
                onChange={(key, value) => setPluginField(manifest.id, key, value)}
                onTestResult={result => setAuthTestResult(result)}
              />
              {authTestResult ? (
                <SettingsNotice tone={authTestResult.ok ? 'success' : 'danger'}>
                  {authTestResult.message}
                  {authTestResult.hint ? ` ${authTestResult.hint}` : ''}
                </SettingsNotice>
              ) : null}
            </div>
          ) : fields.length === 0 ? (
            <SettingsNotice tone="neutral" className="mt-4">
              This plugin doesn't expose configuration. Toggle Enable to register it.
            </SettingsNotice>
          ) : (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {fields.map(field => (
                <Field
                  key={field.name}
                  label={field.label}
                  required={field.required}
                  hint={field.hint}
                  className={field.kind === 'url' ? 'sm:col-span-2' : undefined}
                >
                  {renderFieldInput(field)}
                </Field>
              ))}
            </div>
          )}

          {(onTest || defaultControl || footerNotice) && (
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
              {onTest && !usesAuthPanel ? (
                <TestConnectionButton
                  onTest={() => onTest(entry.config)}
                  disabled={!allRequiredFilled}
                />
              ) : null}
              {defaultControl}
              {footerNotice}
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}
