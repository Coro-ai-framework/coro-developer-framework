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
      <div className="flex items-center gap-2 px-3 py-2 lg:px-5">
        <ScrollArea className="min-w-0 flex-1 whitespace-nowrap">
          <div className="flex items-center gap-2 pr-3">
            {tabs.map(tab => {
              const active = activePath === tab.path

              return (
                <div
                  key={tab.path}
                  className={cn(
                    'group flex min-w-[220px] max-w-[320px] items-center gap-2 rounded-xl border px-3 py-2 transition-colors',
                    active
                      ? 'border-indigo-500/35 bg-indigo-500/10 text-white'
                      : 'border-white/8 bg-white/4 text-slate-300 hover:border-white/14 hover:bg-white/6',
                  )}
                >
                  <Link to={tab.path} className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{tab.title}</div>
                    <div className="truncate text-[11px] uppercase tracking-[0.16em] text-slate-500">{tab.kind}</div>
                  </Link>

                  <button
                    type="button"
                    onClick={() => {
                      const wasActive = activePath === tab.path
                      closeTab(tab.path)
                      if (wasActive) navigate(fallbackRoute())
                    }}
                    className="rounded-full p-1 text-slate-500 transition-colors hover:bg-white/8 hover:text-white"
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
            <Button variant="ghost" size="icon" className="text-slate-400">
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