import {
  Gauge,
  History,
  Plus,
  Settings2,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { NavLink, Outlet } from 'react-router-dom'
import BrandMark from './layout/brand-mark'
import WorkspaceTabsBar from './layout/workspace-tabs-bar'
import { cn } from '../lib/utils'

interface NavigationItem {
  label: string
  to: string
  icon: LucideIcon
  group: 'primary' | 'secondary'
}

/**
 * Single-source navigation. The previous Layout split this into two visual
 * sections in the sidebar and ALSO duplicated the
 * secondary actions in the page-level header. We now show every entry once,
 * grouped only by a subtle divider in the sidebar, and never repeat them
 * in the header.
 */
const NAV: NavigationItem[] = [
  { label: 'Overview', to: '/', icon: Gauge, group: 'primary' },
  { label: 'Runs', to: '/jobs', icon: Workflow, group: 'primary' },
  { label: 'History', to: '/history', icon: History, group: 'primary' },
  { label: 'New Run', to: '/jobs/new', icon: Plus, group: 'secondary' },
  { label: 'Settings', to: '/settings', icon: Settings2, group: 'secondary' },
]

function SidebarLink({ item }: { item: NavigationItem }) {
  return (
    <NavLink
      end={item.to === '/'}
      to={item.to}
      className={({ isActive }) =>
        cn(
          'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
          isActive
            ? 'bg-overlay text-fg'
            : 'text-fg-muted hover:bg-overlay/60 hover:text-fg',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              'flex size-7 items-center justify-center rounded-md transition-colors',
              isActive
                ? 'bg-accent-500/15 text-accent-300'
                : 'text-fg-subtle group-hover:text-fg-muted',
            )}
          >
            <item.icon className="size-4" />
          </span>
          <span className="truncate">{item.label}</span>
          {isActive ? (
            <span className="ml-auto h-4 w-0.5 rounded-full bg-accent-400" aria-hidden />
          ) : null}
        </>
      )}
    </NavLink>
  )
}

function MobileNavLink({ item }: { item: NavigationItem }) {
  return (
    <NavLink
      end={item.to === '/'}
      to={item.to}
      className={({ isActive }) =>
        cn(
          'inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] transition-colors',
          isActive
            ? 'border-accent-500/30 bg-accent-500/10 text-fg'
            : 'border-line bg-overlay/40 text-fg-muted',
        )
      }
    >
      <item.icon className="size-3.5" />
      {item.label}
    </NavLink>
  )
}

export default function Layout() {
  const primary = NAV.filter(item => item.group === 'primary')
  const secondary = NAV.filter(item => item.group === 'secondary')

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
      <aside className="hidden border-r border-line bg-panel/60 px-4 py-5 backdrop-blur-xl lg:flex lg:flex-col lg:gap-6">
        <NavLink to="/" className="px-2">
          <BrandMark />
        </NavLink>

        <nav className="flex flex-col gap-1">
          {primary.map(item => (
            <SidebarLink key={item.to} item={item} />
          ))}
        </nav>

        <div className="my-1 h-px bg-line" />

        <nav className="flex flex-col gap-1">
          {secondary.map(item => (
            <SidebarLink key={item.to} item={item} />
          ))}
        </nav>
      </aside>

      <div className="flex min-h-screen min-w-0 flex-col">
        {/* Mobile-only top bar. Desktop has the full sidebar so it doesn't
            need a second chrome row above content. */}
        <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur-xl lg:hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <NavLink to="/">
              <BrandMark />
            </NavLink>
          </div>
          <nav className="flex gap-1.5 overflow-x-auto px-4 pb-3">
            {NAV.map(item => (
              <MobileNavLink key={item.to} item={item} />
            ))}
          </nav>
        </header>

        <WorkspaceTabsBar />

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
