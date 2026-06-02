import { Link, useNavigate } from 'react-router-dom'
import { MoreHorizontal, PanelTopClose, X } from 'lucide-react'
import { clearNewRunDraftStorage } from '../../lib/new-run-draft'
import { useWorkspaceTabs } from '../../providers/workspace-tabs'
import { Button } from '../ui/button'
import { ScrollArea } from '../ui/scroll-area'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { cn } from '../../lib/utils'

function fallbackRoute() {
  return '/jobs'
}

/**
 * Workspace tab bar. Visually mirrors the underline tab pattern used inside
 * pages (see `components/ui/tabs.tsx`) so the chrome feels consistent. The
 * active tab is marked by an accent underline rather than a raised
 * "browser-like" folder shape; this keeps the header flat and prevents the
 * old layout shift on activation.
 */
export default function WorkspaceTabsBar() {
  const navigate = useNavigate()
  const { tabs, activePath, closeTab, clearTabs } = useWorkspaceTabs()

  if (tabs.length === 0) {
    return null
  }

  return (
    <div className="border-b border-line bg-panel/55 backdrop-blur-xl">
      <div className="flex items-stretch gap-1 px-3 lg:px-6">
        <ScrollArea className="min-w-0 flex-1 whitespace-nowrap">
          <div className="flex items-stretch">
            {tabs.map(tab => {
              const active = activePath === tab.path
              return (
                <div
                  key={tab.path}
                  className={cn(
                    'group relative -mb-px flex h-10 max-w-[220px] items-center gap-1.5 border-b-2 px-3 text-sm transition-[color,border-color]',
                    active
                      ? 'border-accent-400 text-fg'
                      : 'border-transparent text-fg-muted hover:text-fg',
                  )}
                >
                  <Link
                    to={tab.path}
                    className="min-w-0 truncate font-medium focus-visible:outline-none"
                    title={tab.title}
                  >
                    {tab.title}
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      const wasActive = activePath === tab.path
                      if (tab.path === '/jobs/new') clearNewRunDraftStorage()
                      closeTab(tab.path)
                      if (wasActive) navigate(fallbackRoute())
                    }}
                    className={cn(
                      'rounded-full p-0.5 text-fg-subtle transition-colors hover:bg-overlay hover:text-fg',
                      active
                        ? 'opacity-100'
                        : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
                    )}
                    aria-label={`Close ${tab.title}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )
            })}
          </div>
        </ScrollArea>

        <div className="flex items-center">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-fg-subtle">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => {
                  clearNewRunDraftStorage()
                  clearTabs()
                  navigate('/jobs')
                }}
              >
                <PanelTopClose className="size-4" />
                Close all tabs
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {tabs.map(tab => (
                <DropdownMenuItem key={tab.path} onClick={() => navigate(tab.path)}>
                  {tab.title}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}
