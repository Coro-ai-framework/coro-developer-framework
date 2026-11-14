import { useState, useEffect, useCallback, useRef } from 'react'
import { requestText } from '../lib/http'
import type { Job } from '../types'

/**
 * Every job on the runner, without the fields only a job's own page reads
 * (`GET /jobs?view=summary`). Skips polls while the tab is hidden and does
 * not re-render when nothing changed.
 */
export function useJobs(pollIntervalMs = 5000) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const lastBody = useRef<string | null>(null)

  const fetchJobs = useCallback(async () => {
    try {
      const body = await requestText('/jobs?view=summary')
      if (body !== lastBody.current) {
        lastBody.current = body
        setJobs(JSON.parse(body) as Job[])
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch jobs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchJobs()
    const interval = setInterval(() => {
      if (!document.hidden) void fetchJobs()
    }, pollIntervalMs)
    return () => clearInterval(interval)
  }, [fetchJobs, pollIntervalMs])

  return { jobs, loading, error, refetch: fetchJobs }
}
