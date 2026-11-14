import { Outlet } from 'react-router-dom'

/** Conversation and inspector panes manage their own scrolling. */
export function WorkspaceFrame() {
  return (
    <div className="flex h-full min-h-0">
      <Outlet />
    </div>
  )
}

/** Full-width pages: Runs, Reviews, a run or review on its own, Intelligence, Settings. */
export function PageFrame() {
  return (
    <div className="h-full overflow-y-auto">
      <main className="px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <Outlet />
      </main>
    </div>
  )
}
