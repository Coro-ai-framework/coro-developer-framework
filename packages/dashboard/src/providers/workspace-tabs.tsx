import { createContext, useCallback, useContext, useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { useLocalStorage } from '../hooks/use-local-storage'
import { migrateWorkspaceTabs } from '../lib/workspace-tabs'

export interface WorkspaceTab {
  id: string
  /**
   * Workspace tabs are uniformly tagged 'run'. Legacy 'job' and 'campaign'
   * values are accepted on read so older localStorage entries still parse.
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
  const [stored, setStored] = useLocalStorage<WorkspaceTab[]>(STORAGE_KEY, [])
  const tabs = useMemo(() => migrateWorkspaceTabs(stored), [stored])

  useEffect(() => {
    if (tabs.length !== stored.length) setStored(tabs)
  }, [stored, tabs, setStored])

  const upsertTab = useCallback((tab: Omit<WorkspaceTab, 'updatedAt'>) => {
    if (!tab.path || !migrateWorkspaceTabs([{ path: tab.path }]).length) return
    setStored(previous => {
      const nextTab: WorkspaceTab = { ...tab, updatedAt: new Date().toISOString() }
      const current = migrateWorkspaceTabs(previous)
      const existingIndex = current.findIndex(entry => entry.path === tab.path)
      if (existingIndex >= 0) {
        const next = current.slice()
        next[existingIndex] = { ...current[existingIndex], ...nextTab }
        return next
      }
      const appended = [...current, nextTab]
      return appended.length > 10 ? appended.slice(appended.length - 10) : appended
    })
  }, [setStored])

  const closeTab = useCallback((path: string) => {
    setStored(previous => migrateWorkspaceTabs(previous).filter(tab => tab.path !== path))
  }, [setStored])

  const clearTabs = useCallback(() => {
    setStored([])
  }, [setStored])

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
