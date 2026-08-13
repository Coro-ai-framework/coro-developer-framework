import { useCallback, useEffect, useState } from 'react'
import { requestJson } from '../lib/http'
import {
  RETROSPECTIVE_PATH,
  composeApprovalMessage,
  isRetrospectiveJob,
} from '../lib/retrospective'
import type { Job, RetrospectiveSummary } from '../types'

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

export interface FindingsBallot {
  retrospective: RetrospectiveSummary | null
  error: string | null
  /** True while the developer is deciding — i.e. the run is at its gate. */
  selecting: boolean
  /** Approved ids. Every finding starts approved; the developer opts out. */
  approved: ReadonlySet<string>
  toggle: (findingId: string) => void
  /**
   * What the approve button should send. `undefined` for every job that is
   * not a retrospective at its gate, which leaves the button's own default
   * ("Approved, continue") in place.
   */
  approveMessage: string | undefined
}

/**
 * The findings of a retrospective plus the developer's per-finding decision.
 *
 * Defaulting to all-approved matters: the analyst only reports findings it
 * believes in, so the common answer is "yes, all of it", and the toggles
 * exist for the developer who disagrees with one of them. Starting empty
 * would make the frequent case the laborious one.
 *
 * Returns inert values for any job that is not a retrospective, so the run
 * page can call this unconditionally.
 */
export function useFindingsBallot(job: Job | null | undefined): FindingsBallot {
  const isRetro = job ? isRetrospectiveJob(job) : false
  const { retrospective, error } = useRetrospective(
    isRetro ? job?.id : undefined,
    job?.updatedAt,
  )

  const findings = retrospective?.findings ?? []
  const selecting = Boolean(retrospective?.awaitingApproval) && findings.length > 0
  const findingKey = findings.map(f => f.id).join('|')

  const [approved, setApproved] = useState<ReadonlySet<string>>(() => new Set())

  // Re-seed whenever the reported set of findings changes — a new run, or the
  // analyst re-reporting after being sent back with changes. Selections made
  // against findings that no longer exist would ship the wrong thing.
  useEffect(() => {
    setApproved(new Set(findingKey ? findingKey.split('|') : []))
  }, [findingKey])

  const toggle = useCallback((findingId: string) => {
    setApproved(prev => {
      const next = new Set(prev)
      if (next.has(findingId)) next.delete(findingId)
      else next.add(findingId)
      return next
    })
  }, [])

  const approveMessage = selecting ? composeApprovalMessage(findings, approved) : undefined

  return { retrospective, error, selecting, approved, toggle, approveMessage }
}
