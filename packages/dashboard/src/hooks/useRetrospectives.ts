import { useCallback, useEffect, useState } from 'react'
import { requestJson } from '../lib/http'
import { RETROSPECTIVE_PATH } from '../lib/retrospective'
import type { RetrospectiveSummary } from '../types'

/**
 * Every retrospective this install has run, newest first, with findings and
 * outcomes already parsed by the runner. Polled so a run in flight advances
 * without a manual refresh.
 */
export function useRetrospectives(pollIntervalMs = 5000) {
  const [retrospectives, setRetrospectives] = useState<RetrospectiveSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchRetrospectives = useCallback(async () => {
    try {
      const data = await requestJson<RetrospectiveSummary[]>(RETROSPECTIVE_PATH)
      setRetrospectives(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch retrospectives')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchRetrospectives()
    const interval = setInterval(() => void fetchRetrospectives(), pollIntervalMs)
    return () => clearInterval(interval)
  }, [fetchRetrospectives, pollIntervalMs])

  return { retrospectives, loading, error, refetch: fetchRetrospectives }
}

/**
 * One run's findings. Used by the job-detail checkpoint panel, where the
 * caller already polls the job itself — pass the job's `updatedAt` as
 * `revision` to refetch findings whenever the run moves.
 */
export function useRetrospective(jobId: string | undefined, revision?: string) {
  const [retrospective, setRetrospective] = useState<RetrospectiveSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!jobId) return
    let cancelled = false

    requestJson<RetrospectiveSummary>(`${RETROSPECTIVE_PATH}/${encodeURIComponent(jobId)}`)
      .then(data => {
        if (cancelled) return
        setRetrospective(data)
        setError(null)
      })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to fetch retrospective')
      })

    return () => {
      cancelled = true
    }
  }, [jobId, revision])

  return { retrospective, error }
}
