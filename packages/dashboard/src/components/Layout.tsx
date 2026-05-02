import { AppWindowMac, Gauge, History, Plus, Settings2, Workflow } from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import { Button } from './ui/button'
import WorkspaceTabsBar from './layout/workspace-tabs-bar'

interface NavigationItem {
  label: string
  to: string
  icon: typeof Gauge
}

const PRIMARY_NAV: NavigationItem[] = [
  { label: 'Overview', to: '/', icon: Gauge },
  { label: 'Runs', to: '/jobs', icon: Workflow },
  { label: 'History', to: '/history', icon: History },
]

const SECONDARY_NAV: NavigationItem[] = [
  { label: 'New Run', to: '/jobs/new', icon: Plus },
  { label: 'Settings', to: '/settings', icon: Settings2 },
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
      <div className="min-w-0 text-sm font-medium">{item.label}</div>
    </NavLink>
  )
}

export default function Layout() {
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="hidden border-r border-white/8 bg-slate-950/55 px-5 py-5 backdrop-blur-xl lg:flex lg:flex-col lg:gap-6">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl border border-indigo-400/20 bg-indigo-500/10 text-sm font-semibold tracking-[0.16em] text-indigo-100">
              C
            </div>
            <div>
              <div className="text-base font-semibold text-white">Coro Workbench</div>
              <div className="text-xs uppercase tracking-[0.16em] text-slate-500">Runner Operator Console</div>
            </div>
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

        <div className="mt-auto flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-slate-500">
          <AppWindowMac className="size-4" />
          Desktop shell ready
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
                  <p className="text-sm text-slate-500 sm:text-base">Monitor runs, inspect history, and switch context quickly.</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button asChild variant="outline">
                  <NavLink to="/settings">Settings</NavLink>
                </Button>
                <Button asChild>
                  <NavLink to="/jobs/new">New Run</NavLink>
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
