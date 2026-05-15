import { useEffect, useMemo } from 'react'
import Field from '../forms/field'
import type { ProviderModelDescriptor } from './useProviderModels'

/**
 * One option in the provider dropdown. Kept structurally minimal so
 * both Settings (which has full `PluginEntry` objects) and Job Detail
 * (which only knows id + display name from `/plugins`) can feed it.
 */
export interface ProviderOption {
  id: string
  displayName: string
}

export interface ModelPickerValue {
  provider: string
  model: string
}

export interface ModelPickerProps {
  value: ModelPickerValue
  onChange: (next: ModelPickerValue) => void
  /**
   * Enabled provider catalogue used for grouping + display labels.
   * The picker auto-hydrates `modelsByProvider` for every entry.
   */
  providers: ReadonlyArray<ProviderOption>
  /**
   * Model lists keyed by provider id. `null` = loading; `[]` = the
   * provider has no catalogue. Same shape as
   * {@link useProviderModels}.modelsByProvider.
   */
  modelsByProvider: Record<string, ProviderModelDescriptor[] | null | undefined>
  /** Called whenever the picker needs a provider's models hydrated. */
  loadModels: (providerId: string) => Promise<void>
  /** Optional className applied to the wrapper. */
  className?: string
  /** When true, the dropdown is disabled. */
  disabled?: boolean
  /** Hide the "Model" field label (tight popovers). */
  hideLabel?: boolean
  /** Optional override for the visible field label. */
  label?: string
}

/** `${providerId}::${modelId}` — single source of truth for option encoding. */
const VALUE_SEP = '::'
function encode(provider: string, model: string): string {
  if (!provider || !model) return ''
  return `${provider}${VALUE_SEP}${model}`
}
function decode(raw: string): { provider: string; model: string } {
  const idx = raw.indexOf(VALUE_SEP)
  if (idx < 0) return { provider: '', model: '' }
  return { provider: raw.slice(0, idx), model: raw.slice(idx + VALUE_SEP.length) }
}

/**
 * Single combined model dropdown. Lists every model from every
 * enabled provider, grouped under `<optgroup>` by provider display
 * name. Provider is inferred from the chosen option — callers no
 * longer need to pick provider separately.
 *
 * Pure presentational: no fetching beyond the on-mount catalogue
 * hydration; state lives in the parent.
 */
export default function ModelPicker({
  value,
  onChange,
  providers,
  modelsByProvider,
  loadModels,
  className,
  disabled = false,
  hideLabel = false,
  label = 'Model',
}: ModelPickerProps) {
  // Hydrate every enabled provider's catalogue once. Re-runs are
  // cheap because the cache de-dupes on provider id.
  const providerKey = providers.map(p => p.id).join('|')
  useEffect(() => {
    for (const p of providers) void loadModels(p.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerKey])

  const anyLoading = useMemo(
    () => providers.some(p => modelsByProvider[p.id] === null || modelsByProvider[p.id] === undefined),
    [providers, modelsByProvider],
  )
  const totalModels = useMemo(
    () => providers.reduce((n, p) => n + (modelsByProvider[p.id]?.length ?? 0), 0),
    [providers, modelsByProvider],
  )

  const currentEncoded = encode(value.provider, value.model)
  // The saved value may not match any hydrated catalogue (e.g. older
  // config or provider currently disabled). Render it as a sticky
  // option so the select shows the user what they have configured.
  const currentInCatalogue =
    !!value.provider && !!value.model
    && (modelsByProvider[value.provider] ?? []).some(m => m.id === value.model)
  const showStickyCurrent = !!value.model && !currentInCatalogue

  const placeholderText =
    providers.length === 0
      ? '(no enabled providers)'
      : anyLoading && totalModels === 0
        ? 'Loading…'
        : totalModels === 0
          ? '(no models published)'
          : '(select a model)'

  return (
    <Field label={hideLabel ? '' : label} className={className}>
      <select
        value={currentEncoded}
        disabled={disabled || providers.length === 0}
        onChange={e => onChange(decode(e.target.value))}
        className="w-full rounded-xl border border-line bg-overlay px-3 py-2 text-sm text-fg disabled:opacity-60"
        aria-label={hideLabel ? label : undefined}
      >
        <option value="">{placeholderText}</option>
        {showStickyCurrent ? (
          <option value={currentEncoded}>
            {value.model} · {value.provider} (saved)
          </option>
        ) : null}
        {providers.map(p => {
          const models = modelsByProvider[p.id]
          if (!models || models.length === 0) return null
          return (
            <optgroup key={p.id} label={p.displayName}>
              {models.map(m => (
                <option key={`${p.id}::${m.id}`} value={encode(p.id, m.id)}>
                  {m.displayName}
                </option>
              ))}
            </optgroup>
          )
        })}
      </select>
    </Field>
  )
}
