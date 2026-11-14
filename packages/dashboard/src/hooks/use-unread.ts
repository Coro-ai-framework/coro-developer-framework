import { useEffect, useMemo, useRef, useState } from 'react'
import { reconcileSeen, worklistItems, type SeenMap } from '../lib/unread'
import type { Worklist } from '../lib/worklist'

const STORAGE_KEY = 'coro.worklist.seen'

function load(): SeenMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as SeenMap) : {}
  } catch {
    return {}
  }
}

/**
 * Keys of rows that changed since the developer last had them on screen.
 * Nothing is reconciled while the first poll is outstanding: an empty list
 * would otherwise prune every remembered row and lose unread across reloads.
 */
export function useUnread(worklist: Worklist, visibleKeys: ReadonlySet<string>, loading: boolean): ReadonlySet<string> {
  const seenRef = useRef<SeenMap | null>(null)
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set())

  const visibleSignature = useMemo(() => [...visibleKeys].sort().join('|'), [visibleKeys])

  useEffect(() => {
    if (loading) return
    if (!seenRef.current) seenRef.current = load()
    const result = reconcileSeen(seenRef.current, worklistItems(worklist), visibleKeys)
    seenRef.current = result.seen
    if (result.changed) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(result.seen))
      } catch {
        // Unread is a convenience; a full quota must not break the list.
      }
    }
    setUnread(previous => (sameSet(previous, result.unread) ? previous : result.unread))
    // visibleKeys is represented by its signature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worklist, visibleSignature, loading])

  return unread
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}
