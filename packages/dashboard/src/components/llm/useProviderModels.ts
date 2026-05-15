import { useCallback, useEffect, useState } from 'react'
import { ApiError, requestJson } from '../../lib/http'

/**
 * Minimal model descriptor as exposed by `GET /plugins/:id/models`.
 * Pricing fields are optional and reserved for the cost-preview work
 * (Phase 5 of the alias-UX plan); consumers should treat them as
 * potentially-undefined for the foreseeable future.
 */
export interface ProviderModelDescriptor {
  id: string
  displayName: string
  pricing?: {
    inputPer1kUsd?: number
    outputPer1kUsd?: number
    cacheReadPer1kUsd?: number
  }
}

interface ModelsResponse {
  models?: ProviderModelDescriptor[]
}

/**
 * Per-provider model cache shared by every LLM picker surface.
 *
 * State convention:
 *   - `undefined` — never requested.
 *   - `null`      — request in flight.
 *   - `[]`        — provider has no catalogue (or fetch errored). The
 *                   caller should fall back to a free-form input.
 *   - `T[]`       — populated.
 *
 * One instance per consuming component is fine; the network layer is
 * idempotent and the dashboard isn't memory-pressured. We deliberately
 * avoid a global cache to keep React state ownership obvious.
 */
export function useProviderModels(): {
  modelsByProvider: Record<string, ProviderModelDescriptor[] | null | undefined>
  loadModels: (providerId: string) => Promise<void>
} {
  const [modelsByProvider, setModelsByProvider] = useState<
    Record<string, ProviderModelDescriptor[] | null | undefined>
  >({})

  const loadModels = useCallback(async (providerId: string) => {
    if (!providerId) return
    if (modelsByProvider[providerId] !== undefined) return
    setModelsByProvider(prev => ({ ...prev, [providerId]: null }))
    try {
      const data = await requestJson<ModelsResponse>(
        `/plugins/${encodeURIComponent(providerId)}/models`,
      )
      setModelsByProvider(prev => ({ ...prev, [providerId]: data.models ?? [] }))
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      setModelsByProvider(prev => ({ ...prev, [providerId]: [] }))
    }
  }, [modelsByProvider])

  return { modelsByProvider, loadModels }
}

/**
 * Convenience: eagerly hydrates `loadModels` for every provider id in
 * `providerIds`. Mirrors the prefetch loop the Settings page used to
 * inline directly. Safe to call with a list that mutates over time.
 */
export function usePrefetchProviderModels(
  providerIds: ReadonlyArray<string>,
  loadModels: (providerId: string) => Promise<void>,
): void {
  useEffect(() => {
    const seen = new Set<string>()
    for (const id of providerIds) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      void loadModels(id)
    }
    // loadModels intentionally excluded — the hook returns a fresh
    // function on every cache change, which would cause an infinite
    // refetch loop. The function is stable enough for our purposes:
    // it always reads the latest cache via the setter callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerIds.join('|')])
}
