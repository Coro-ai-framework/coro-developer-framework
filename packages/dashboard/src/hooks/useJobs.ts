import { useState, useEffect, useCallback } from 'react'
import { requestJson } from '../lib/http'
import type { Job } from '../types'

export function useJobs(pollIntervalMs = 5000) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchJobs = useCallback(async () => {
    try {
      const data = await requestJson<Job[]>('/jobs')
      setJobs(data)
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
