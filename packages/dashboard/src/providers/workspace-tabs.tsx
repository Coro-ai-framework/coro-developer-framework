import { createContext, useCallback, useContext, useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { useLocalStorage } from '../hooks/use-local-storage'

export interface WorkspaceTab {
  id: string
  /**
   * Workspace tabs are now uniformly tagged 'run' to match the unified Runs
   * surface. The legacy 'job' and 'campaign' values are accepted on read so
   * persisted localStorage entries from older sessions don't break.
   */
  kind: 'run' | 'job' | 'campaign'
  path: string
  title: string
  subtitle?: string
  updatedAt: string
}

interface WorkspaceTabsContextValue {
  tabs: WorkspaceTab[]
  activePath: string
  upsertTab: (tab: Omit<WorkspaceTab, 'updatedAt'>) => void
  closeTab: (path: string) => void
  clearTabs: () => void
}

const STORAGE_KEY = 'coro.workspace.tabs'

const WorkspaceTabsContext = createContext<WorkspaceTabsContextValue | null>(null)

export function WorkspaceTabsProvider({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const [tabs, setTabs] = useLocalStorage<WorkspaceTab[]>(STORAGE_KEY, [])

  const upsertTab = useCallback((tab: Omit<WorkspaceTab, 'updatedAt'>) => {
    setTabs(previous => {
      const nextTab: WorkspaceTab = { ...tab, updatedAt: new Date().toISOString() }
      const existingIndex = previous.findIndex(entry => entry.path === tab.path)
      if (existingIndex >= 0) {
        // Preserve position so activating a tab doesn't visually shuffle the
        // bar. We only refresh metadata (title, subtitle, updatedAt) in place.
        const next = previous.slice()
        next[existingIndex] = { ...previous[existingIndex], ...nextTab }
        return next
      }
      // New tab → append to the end (most recent on the right), capped at 10.
      const appended = [...previous, nextTab]
      return appended.length > 10 ? appended.slice(appended.length - 10) : appended
    })
  }, [setTabs])

  const closeTab = useCallback((path: string) => {
    setTabs(previous => previous.filter(tab => tab.path !== path))
  }, [setTabs])

  const clearTabs = useCallback(() => {
    setTabs([])
  }, [setTabs])

  useEffect(() => {
    setTabs(previous => previous.map(tab => (
      tab.path === location.pathname
        ? { ...tab, updatedAt: new Date().toISOString() }
        : tab
    )))
  }, [location.pathname, setTabs])

  const value = useMemo<WorkspaceTabsContextValue>(() => ({
    tabs,
    activePath: location.pathname,
    upsertTab,
    closeTab,
    clearTabs,
  }), [tabs, location.pathname, upsertTab, closeTab, clearTabs])

  return (
    <WorkspaceTabsContext.Provider value={value}>
      {children}
    </WorkspaceTabsContext.Provider>
  )
}

export function useWorkspaceTabs() {
  const context = useContext(WorkspaceTabsContext)
  if (!context) {
    throw new Error('useWorkspaceTabs must be used inside WorkspaceTabsProvider')
  }

  return context
}

export function useRegisterWorkspaceTab(tab: Omit<WorkspaceTab, 'updatedAt'> | null) {
  const { upsertTab } = useWorkspaceTabs()
  const id = tab?.id
  const kind = tab?.kind
  const path = tab?.path
  const title = tab?.title
  const subtitle = tab?.subtitle

  useEffect(() => {
    if (!id || !kind || !path || !title) return
    upsertTab({ id, kind, path, title, subtitle })
  }, [id, kind, path, subtitle, title, upsertTab])
}