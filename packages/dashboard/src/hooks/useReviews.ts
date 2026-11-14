import { useCallback, useEffect, useState } from 'react'
import { requestJson } from '../lib/http'
import { REVIEWS_PATH, type PrReview, type ReviewEngineStatus } from '../lib/reviews'

/** Every review this runner knows about. Polled so rounds advance without a refresh. */
export function useReviews(pollIntervalMs = 5000) {
  const [reviews, setReviews] = useState<PrReview[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    try {
      setReviews(await requestJson<PrReview[]>(REVIEWS_PATH))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load reviews')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refetch()
    const interval = setInterval(() => void refetch(), pollIntervalMs)
    return () => clearInterval(interval)
  }, [refetch, pollIntervalMs])

  return { reviews, loading, error, refetch, setReviews }
}

/** One review. `pollIntervalMs: 0` fetches once; call `refetch` when something says it changed. */
export function useReview(id: string | undefined, pollIntervalMs = 4000) {
  const [review, setReview] = useState<PrReview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  const refetch = useCallback(async () => {
    if (!id) return
    try {
      setReview(await requestJson<PrReview>(`${REVIEWS_PATH}/${encodeURIComponent(id)}`))
      setError(null)
      setMissing(false)
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status === 404) setMissing(true)
      else setError(err instanceof Error ? err.message : 'Could not load the review')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void refetch()
    if (!pollIntervalMs) return
    const interval = setInterval(() => {
      if (!document.hidden) void refetch()
    }, pollIntervalMs)
    return () => clearInterval(interval)
  }, [refetch, pollIntervalMs])

  return { review, loading, error, missing, refetch, setReview }
}

export function useReviewEngine(pollIntervalMs = 10000) {
  const [status, setStatus] = useState<ReviewEngineStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refetch = useCallback(async () => {
    try {
      setStatus(await requestJson<ReviewEngineStatus>(`${REVIEWS_PATH}/status`))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the review engine status')
    }
  }, [])

  useEffect(() => {
    void refetch()
    const interval = setInterval(() => void refetch(), pollIntervalMs)
    return () => clearInterval(interval)
  }, [refetch, pollIntervalMs])

  return { status, error, refetch, setStatus }
}
