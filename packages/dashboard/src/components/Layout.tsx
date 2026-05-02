import { AppWindowMac, FolderKanban, Gauge, History, Plus, Settings2, Workflow } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { Button } from './ui/button'
import WorkspaceTabsBar from './layout/workspace-tabs-bar'

interface NavigationItem {
  label: string
  description: string
  to: string
  icon: typeof Gauge
}

const PRIMARY_NAV: NavigationItem[] = [
  { label: 'Overview', description: 'Live operator summary', to: '/', icon: Gauge },
  { label: 'Jobs', description: 'Single-run work items', to: '/jobs', icon: Workflow },
  { label: 'Campaigns', description: 'Coordinated work', to: '/campaigns', icon: FolderKanban },
  { label: 'History', description: 'Archived runs', to: '/history', icon: History },
]

const SECONDARY_NAV: NavigationItem[] = [
  { label: 'New Job', description: 'Dispatch work', to: '/jobs/new', icon: Plus },
  { label: 'Settings', description: 'Runner configuration', to: '/settings', icon: Settings2 },
]

function SidebarLink({ item }: { item: NavigationItem }) {
  return (
    <NavLink
      end={item.to === '/'}
      to={item.to}
      className={({ isActive }) => `group flex items-start gap-3 rounded-2xl border px-4 py-3 transition-colors ${
        isActive
          ? 'border-indigo-500/35 bg-indigo-500/10 text-white'
          : 'border-white/6 bg-white/[0.03] text-slate-300 hover:border-white/12 hover:bg-white/[0.05]'
      }`}
    >
      <div className="rounded-xl border border-white/8 bg-white/6 p-2.5 text-slate-200">
        <item.icon className="size-4" />
      </div>
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm font-medium">{item.label}</div>
        <div className="text-xs text-slate-500">{item.description}</div>
      </div>
    </NavLink>
  )
}

export default function Layout() {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="hidden border-r border-white/8 bg-slate-950/55 px-5 py-5 backdrop-blur-xl lg:flex lg:flex-col lg:gap-6">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-400 via-indigo-500 to-cyan-400 text-sm font-semibold tracking-[0.16em] text-slate-950 shadow-[0_20px_45px_-28px_rgba(97,114,255,0.9)]">
              C
            </div>
            <div>
              <div className="text-base font-semibold text-white">Coro Workbench</div>
              <div className="text-xs uppercase tracking-[0.16em] text-slate-500">Runner Operator Console</div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-4 text-sm text-slate-400">
            Electron-ready UI focused on high-density job monitoring, campaign control, and fast drill-down workflows.
          </div>
        </div>

        <div className="space-y-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Workbench</div>
          <nav className="space-y-2">
            {PRIMARY_NAV.map(item => <SidebarLink key={item.to} item={item} />)}
          </nav>
        </div>

        <div className="space-y-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Controls</div>
          <nav className="space-y-2">
            {SECONDARY_NAV.map(item => <SidebarLink key={item.to} item={item} />)}
          </nav>
        </div>

        <div className="mt-auto rounded-2xl border border-white/8 bg-white/[0.03] p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-white">
            <AppWindowMac className="size-4 text-cyan-300" />
            Desktop-first shell
          </div>
          <p className="mt-2 text-sm text-slate-400">
            The layout is optimized for the later Electron shell: persistent navigation, fast switching, and multi-tasking through workspace tabs.
          </p>
        </div>
      </aside>

      <div className="flex min-h-screen min-w-0 flex-col">
        <header className="sticky top-0 z-40 border-b border-white/8 bg-slate-950/72 backdrop-blur-xl">
          <div className="flex flex-col gap-4 px-4 py-4 sm:px-5 lg:px-6">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-2">
                <div className="text-[11px] font-medium uppercase tracking-[0.2em] text-slate-500">Operator Workspace</div>
                <div>
                  <h1 className="text-2xl font-semibold text-white sm:text-[2rem]">Coro Dashboard</h1>
                  <p className="text-sm text-slate-400 sm:text-base">Monitor jobs, coordinate campaigns, inspect history, and keep multiple workspaces open at once.</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button asChild variant="outline">
                  <NavLink to="/settings">Settings</NavLink>
                </Button>
                <Button asChild>
                  <NavLink to="/jobs/new">New Job</NavLink>
                </Button>
              </div>
            </div>

            <nav className="flex gap-2 overflow-x-auto pb-1 lg:hidden">
              {[...PRIMARY_NAV, ...SECONDARY_NAV].map(item => (
                <NavLink
                  key={item.to}
                  end={item.to === '/'}
                  to={item.to}
                  className={({ isActive }) => `inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors ${
                    isActive
                      ? 'border-indigo-500/35 bg-indigo-500/10 text-white'
                      : 'border-white/8 bg-white/[0.03] text-slate-300'
                  }`}
                >
                  <item.icon className="size-4" />
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <WorkspaceTabsBar />
        </header>

        <main className="flex-1 px-4 py-6 sm:px-5 lg:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
