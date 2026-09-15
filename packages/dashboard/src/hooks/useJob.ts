import { useCallback, useEffect, useState } from 'react'
import { requestJson } from '../lib/http'
import { isTerminalStatus } from '../lib/status'
import type { Job } from '../types'

export function useJob(jobId: string | undefined, pollIntervalMs?: number) {
  const [job, setJob] = useState<Job | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchJob = useCallback(async () => {
    if (!jobId) return
    try {
      const data = await requestJson<Job>(`/jobs/${jobId}`)
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

  // Opt-in polling for surfaces that have no other refresh signal (the
  // intake chat's active-run card). Job detail drives its own interval
  // because it also refetches on phase lines from the log stream. Stops
  // once the run can no longer change.
  useEffect(() => {
    if (!pollIntervalMs || !jobId) return
    if (job && isTerminalStatus(job.status)) return
    const interval = setInterval(() => void fetchJob(), pollIntervalMs)
    return () => clearInterval(interval)
  }, [fetchJob, job?.status, jobId, pollIntervalMs])

  return { job, loading, error, refetch: fetchJob }
}
