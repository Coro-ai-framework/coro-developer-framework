import { useCallback, useEffect, useState, type SetStateAction } from 'react'

const SAME_TAB_EVENT = 'coro:local-storage'

function read<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const stored = window.localStorage.getItem(key)
    return stored ? (JSON.parse(stored) as T) : fallback
  } catch {
    return fallback
  }
}

/**
 * State persisted under `key`. Every instance using the same key stays in
 * step — in this tab and in others — so a setting changed in one place takes
 * effect everywhere that reads it.
 */
export function useLocalStorage<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => read(key, fallback))

  useEffect(() => {
    const sync = (event: Event) => {
      const changedKey = event instanceof StorageEvent ? event.key : (event as CustomEvent<string>).detail
      if (changedKey === key) setValue(read(key, fallback))
    }
    window.addEventListener('storage', sync)
    window.addEventListener(SAME_TAB_EVENT, sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener(SAME_TAB_EVENT, sync)
    }
    // `fallback` only matters when nothing is stored; it is read fresh above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const update = useCallback((next: SetStateAction<T>) => {
    setValue(previous => {
      const resolved = typeof next === 'function' ? (next as (prev: T) => T)(previous) : next
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved))
        queueMicrotask(() => window.dispatchEvent(new CustomEvent(SAME_TAB_EVENT, { detail: key })))
      } catch {
        // Ignore storage quota and serialization failures.
      }
      return resolved
    })
  }, [key])

  return [value, update] as const
}
