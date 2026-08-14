import { useCallback, useEffect, useState } from 'react'
import { requestJson } from '../lib/http'
import type { PluginCatalogEntry, StepKind } from '../lib/plugin-catalog-types'
import { kindForStep } from '../lib/plugin-catalog-types'

interface CatalogResponse {
  plugins: PluginCatalogEntry[]
}

// Module-level cache with a subscriber list. The wizard renders several
// consumers of this hook at once (one per step, plus the plugin drawer), so a
// refresh has to reach all of them — with per-component state only, installing
// a plugin in the drawer left every other step showing the stale list.
let cachedCatalog: PluginCatalogEntry[] | null = null
let inflight: Promise<PluginCatalogEntry[]> | null = null
const subscribers = new Set<(list: PluginCatalogEntry[]) => void>()

function publish(list: PluginCatalogEntry[]): void {
  cachedCatalog = list
  for (const notify of subscribers) notify(list)
}

async function fetchCatalog(): Promise<PluginCatalogEntry[]> {
  if (cachedCatalog) return cachedCatalog
  if (inflight) return inflight
  inflight = requestJson<CatalogResponse>('/config/plugins/catalog').then(res => {
    publish(res.plugins)
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
    let cancelled = false
    const onPublish = (list: PluginCatalogEntry[]): void => {
      if (!cancelled) {
        setPlugins(list)
        setLoading(false)
        setError(null)
      }
    }
    subscribers.add(onPublish)

    if (cachedCatalog) {
      setPlugins(cachedCatalog)
      setLoading(false)
    } else {
      void fetchCatalog().catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })
    }
    return () => {
      cancelled = true
      subscribers.delete(onPublish)
    }
  }, [])

  const refresh = useCallback(async (): Promise<PluginCatalogEntry[]> => {
    cachedCatalog = null
    try {
      const list = await fetchCatalog()
      return list
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      throw err
    }
  }, [])

  return { plugins, loading, error, refresh }
}

export function getProvidersForStep(
  plugins: PluginCatalogEntry[] | null,
  step: StepKind,
): PluginCatalogEntry[] {
  if (!plugins) return []
  const kind = kindForStep(step)
  return plugins.filter(p => p.kind === kind)
}

/**
 * Drop the cached catalog and re-fetch for every mounted consumer. Call after
 * anything that changes which plugins exist or how they are configured
 * (install, uninstall, a committed wizard step).
 */
export function invalidateProviderCatalogCache(): void {
  cachedCatalog = null
  if (subscribers.size === 0) return
  void fetchCatalog().catch(() => {
    // Consumers keep the list they already have; the next mount retries.
  })
}
