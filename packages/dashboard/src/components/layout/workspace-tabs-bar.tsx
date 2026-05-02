import { Link, useNavigate } from 'react-router-dom'
import { MoreHorizontal, PanelTopClose, X } from 'lucide-react'
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

export default function WorkspaceTabsBar() {
  const navigate = useNavigate()
  const { tabs, activePath, closeTab, clearTabs } = useWorkspaceTabs()

  if (tabs.length === 0) {
    return null
  }

  return (
    <div className="border-b border-line bg-panel/55 backdrop-blur-xl">
      <div className="flex items-end gap-1.5 px-3 pt-2 lg:px-6">
        <ScrollArea className="min-w-0 flex-1 whitespace-nowrap">
          <div className="flex items-end gap-0.5 pr-3">
            {tabs.map(tab => {
              const active = activePath === tab.path

              return (
                <div
                  key={tab.path}
                  className={cn(
                    'group -mb-px flex min-w-[180px] max-w-[260px] items-center gap-2 rounded-t-lg border border-b-0 px-3 py-2 transition-colors',
                    active
                      ? 'border-line-strong bg-canvas text-fg'
                      : 'border-transparent text-fg-muted hover:bg-overlay/50 hover:text-fg',
                  )}
                >
                  <Link to={tab.path} className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{tab.title}</div>
                    <div
                      className={cn(
                        'truncate text-[10px] uppercase tracking-[0.16em]',
                        active ? 'text-fg-subtle' : 'text-fg-subtle/80',
                      )}
                    >
                      {tab.kind}
                    </div>
                  </Link>

                  <button
                    type="button"
                    onClick={() => {
                      const wasActive = activePath === tab.path
                      closeTab(tab.path)
                      if (wasActive) navigate(fallbackRoute())
                    }}
                    className="rounded-full p-0.5 text-fg-subtle transition-colors hover:bg-overlay hover:text-fg"
                    aria-label={`Close ${tab.title}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )
            })}
          </div>
        </ScrollArea>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="mb-1 h-7 w-7 text-fg-subtle">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => {
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
  )
}
