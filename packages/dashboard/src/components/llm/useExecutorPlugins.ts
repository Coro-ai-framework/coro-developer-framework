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
          // Only LLM executors back the model dropdown. We surface
          // installed plugins regardless of `active` so a misconfigured
          // provider still shows up — matches Settings semantics where
          // the user can pick a provider and *then* configure it.
          .filter(p => p.manifest.kind === 'executor' && p.installed !== false)
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
