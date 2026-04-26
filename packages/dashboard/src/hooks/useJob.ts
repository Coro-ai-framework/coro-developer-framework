import { useState, useEffect, useCallback } from 'react'
import type { Job } from '../types'

export function useJob(jobId: string | undefined) {
  const [job, setJob] = useState<Job | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchJob = useCallback(async () => {
    if (!jobId) return
    try {
      const res = await fetch(`/jobs/${jobId}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as Job
      setJob(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch job')
    } finally {
      setLoading(false)
    }
  }, [jobId])

  useEffect(() => {
    void fetchJob()
  }, [fetchJob])

  return { job, loading, error, refetch: fetchJob }
}
