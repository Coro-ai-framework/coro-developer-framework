import { createContext, useCallback, useContext, useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { useLocalStorage } from '../hooks/use-local-storage'

export interface WorkspaceTab {
  id: string
  kind: 'job' | 'campaign'
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
      const withoutDuplicate = previous.filter(entry => entry.path !== tab.path)
      return [nextTab, ...withoutDuplicate].slice(0, 10)
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