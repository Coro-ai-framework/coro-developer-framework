import { useEffect, useState } from 'react'

export function useLocalStorage<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return fallback

    try {
      const stored = window.localStorage.getItem(key)
      return stored ? JSON.parse(stored) as T : fallback
    } catch {
      return fallback
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Ignore storage quota and serialization failures.
    }
  }, [key, value])

  return [value, setValue] as const
}