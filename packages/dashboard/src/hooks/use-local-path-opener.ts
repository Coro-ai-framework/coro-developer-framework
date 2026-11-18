import { useEffect, useMemo, useState } from 'react'
import { fetchEditors, openConversationPath } from '../lib/open-workspace'

let localRunner: Promise<boolean> | null = null

/**
 * Opens a path a conversation mentioned on this computer. Undefined unless the
 * runner is in local mode — only then does it share the developer's desktop.
 */
export function useLocalPathOpener(sessionId: string | undefined): ((path: string) => Promise<string>) | undefined {
  const [local, setLocal] = useState(false)

  useEffect(() => {
    let live = true
    localRunner ??= fetchEditors().then(
      response => response.mode === 'local',
      () => {
        localRunner = null
        return false
      },
    )
    void localRunner.then(value => {
      if (live) setLocal(value)
    })
    return () => {
      live = false
    }
  }, [])

  return useMemo(
    () => (local && sessionId ? (path: string) => openConversationPath(sessionId, path) : undefined),
    [local, sessionId],
  )
}
