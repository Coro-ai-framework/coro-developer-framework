import { useEffect, useState } from 'react'
import { ApiError, requestJson } from '../../lib/http'
import type { ProviderOption } from './ModelPicker'

/**
 * Plugin manifest summary — same shape as
 * {@link import('../../pages/Settings/SettingsContext').PluginsCatalogue.plugins[number]}
 * but pruned to the fields needed by `ModelPicker` / phase-override UIs.
 * We re-fetch `/plugins` here instead of going through `useSettings()`
 * because Job Detail isn't mounted under `<SettingsProvider>`.
 */
interface PluginsResponse {
  plugins: Array<{
    manifest: { id: string; kind: string; displayName: string }
    installed?: boolean
    active?: boolean
    source?: 'builtin' | 'dropin'
  }>
}

/**
 * Minimal hook for surfaces that need the executor plugin catalogue
 * but don't have access to the settings draft. Returns the same
 * "active executor" list a settings-aware caller would compute, so
 * the model picker stays in sync across surfaces.
 *
 * Loading state is exposed but most callers can render a disabled
 * picker while `loading` is true.
 */
export function useExecutorPlugins(): {
  providers: ProviderOption[]
  loading: boolean
  error: string | null
} {
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const data = await requestJson<PluginsResponse>('/plugins')
        if (cancelled) return
        const next = data.plugins
          // Only LLM executors back the model dropdown. Surface every
          // executor that is *available* to the runner, not just those
          // with an enabled config slot: built-in executors (Anthropic,
          // OpenAI) are auto-loaded (`active: true`) even before the
          // user configures credentials, and a configured-but-broken
          // provider (`installed: true`) should stay visible too. This
          // matches the Settings LLM editor, which treats every
          // discovered executor as selectable so the user can pick a
          // provider and *then* configure it. Without this, a provider
          // like OpenAI — and every model in its catalogue — silently
          // disappears from Coro plan mode and per-phase pickers until
          // it happens to have an enabled slot on disk.
          .filter(
            p =>
              p.manifest.kind === 'executor' &&
              (p.active !== false || p.installed !== false || p.source === 'builtin'),
          )
          .map(p => ({ id: p.manifest.id, displayName: p.manifest.displayName }))
          .sort((a, b) => a.displayName.localeCompare(b.displayName))
        setProviders(next)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return { providers, loading, error }
}
