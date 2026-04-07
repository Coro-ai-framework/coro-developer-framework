import { useState, useEffect, useCallback } from 'react'
import type { JobSummary } from '../types'

export function useJobs(pollIntervalMs = 5000) {
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/jobs')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as { jobs: JobSummary[] }
      setJobs(data.jobs)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch jobs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchJobs()
    const interval = setInterval(() => void fetchJobs(), pollIntervalMs)
    return () => clearInterval(interval)
  }, [fetchJobs, pollIntervalMs])

  return { jobs, loading, error, refetch: fetchJobs }
}
