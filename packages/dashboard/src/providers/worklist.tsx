import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { requestText } from '../lib/http'
import { EMPTY_WORKLIST, type Worklist } from '../lib/worklist'

/** Fast enough that a run parking on a question shows up while you are still looking. */
const POLL_MS = 3_000

interface WorklistContextValue {
  worklist: Worklist
  /** True until the first successful answer. A failed first poll keeps it true, so nothing treats "unreachable" as "empty". */
  loading: boolean
  error: string | null
  /** Fetch now, e.g. right after this tab started or changed something. */
  refresh: () => void
}

const WorklistContext = createContext<WorklistContextValue | null>(null)

/**
 * The one poll behind the sidebar, the needs-you count and the window title.
 * Nothing else polls `/worklist`. The runner answers unchanged lists with a
 * 304, and an unchanged body never re-renders the tree.
 */
export function WorklistProvider({ children }: { children: ReactNode }) {
  const [worklist, setWorklist] = useState<Worklist>(EMPTY_WORKLIST)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const lastBody = useRef<string | null>(null)
  const inflight = useRef(false)
  const queued = useRef(false)

  const fetchNow = useCallback(async () => {
    if (inflight.current) {
      queued.current = true
      return
    }
    inflight.current = true
    try {
      const body = await requestText('/worklist')
      if (body !== lastBody.current) {
        lastBody.current = body
        setWorklist(JSON.parse(body) as Worklist)
      }
      setError(null)
      setLoading(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load work')
    } finally {
      inflight.current = false
      if (queued.current) {
        queued.current = false
        void fetchNow()
      }
    }
  }, [])

  useEffect(() => {
    void fetchNow()
    const timer = window.setInterval(() => {
      if (!document.hidden) void fetchNow()
    }, POLL_MS)
    const onVisible = () => {
      if (!document.hidden) void fetchNow()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [fetchNow])

  const refresh = useCallback(() => {
    void fetchNow()
  }, [fetchNow])

  const value = useMemo<WorklistContextValue>(
    () => ({ worklist, loading, error, refresh }),
    [worklist, loading, error, refresh],
  )

  return <WorklistContext.Provider value={value}>{children}</WorklistContext.Provider>
}

export function useWorklist(): WorklistContextValue {
  const context = useContext(WorklistContext)
  if (!context) throw new Error('useWorklist must be used inside WorklistProvider')
  return context
}

/** Outside the provider (tests, isolated renders) this is a no-op. */
export function useRefreshWorklist(): () => void {
  return useContext(WorklistContext)?.refresh ?? noop
}

function noop() {}
