import { useEffect, useState } from 'react'
import { requestJson } from '../lib/http'
import type { PluginCatalogEntry, StepKind } from '../lib/plugin-catalog-types'
import { kindForStep } from '../lib/plugin-catalog-types'

interface CatalogResponse {
  plugins: PluginCatalogEntry[]
}

let cachedCatalog: PluginCatalogEntry[] | null = null
let inflight: Promise<PluginCatalogEntry[]> | null = null

async function fetchCatalog(): Promise<PluginCatalogEntry[]> {
  if (cachedCatalog) return cachedCatalog
  if (inflight) return inflight
  inflight = requestJson<CatalogResponse>('/config/plugins/catalog').then(res => {
    cachedCatalog = res.plugins
    return res.plugins
  }).finally(() => {
    inflight = null
  })
  return inflight
}

export function useProviderCatalog() {
  const [plugins, setPlugins] = useState<PluginCatalogEntry[] | null>(cachedCatalog)
  const [loading, setLoading] = useState(!cachedCatalog)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (cachedCatalog) {
      setPlugins(cachedCatalog)
      setLoading(false)
      return
    }
    let cancelled = false
    void fetchCatalog()
      .then(list => {
        if (!cancelled) {
          setPlugins(list)
          setLoading(false)
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { plugins, loading, error, refresh: async () => {
    cachedCatalog = null
    const list = await fetchCatalog()
    setPlugins(list)
    return list
  } }
}

export function getProvidersForStep(
  plugins: PluginCatalogEntry[] | null,
  step: StepKind,
): PluginCatalogEntry[] {
  if (!plugins) return []
  const kind = kindForStep(step)
  return plugins.filter(p => p.kind === kind)
}

export function invalidateProviderCatalogCache(): void {
  cachedCatalog = null
}
