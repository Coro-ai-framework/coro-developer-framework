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
    <div className="border-b border-white/8 bg-slate-950/72 backdrop-blur-xl">
      <div className="flex items-end gap-2 px-3 pt-2 lg:px-5">
        <ScrollArea className="min-w-0 flex-1 whitespace-nowrap">
          <div className="flex items-end gap-1 pr-3">
            {tabs.map(tab => {
              const active = activePath === tab.path

              return (
                <div
                  key={tab.path}
                  className={cn(
                    'group -mb-px flex min-w-[220px] max-w-[320px] items-center gap-2 rounded-t-xl border border-b-0 px-3 py-2.5 transition-colors',
                    active
                      ? 'border-white/12 bg-slate-950 text-white shadow-[0_-1px_0_rgba(255,255,255,0.04)]'
                      : 'border-transparent bg-white/[0.02] text-slate-400 hover:bg-white/[0.04] hover:text-white',
                  )}
                >
                  <Link to={tab.path} className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{tab.title}</div>
                    <div className={cn('truncate text-[11px] uppercase tracking-[0.16em]', active ? 'text-slate-500' : 'text-slate-600 group-hover:text-slate-500')}>
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
                    className="rounded-full p-1 text-slate-600 transition-colors hover:bg-white/8 hover:text-white"
                    aria-label={`Close ${tab.title}`}
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        </ScrollArea>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="mb-1 text-slate-400">
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