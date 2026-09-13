import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { MoreHorizontal, PanelTopClose, X } from 'lucide-react'
import { useWorkspaceTabs } from '../../providers/workspace-tabs'
import { useJobs } from '../../hooks/useJobs'
import { getTabStatus, toneDotClasses } from '../../lib/status'
import { HOME_PATH } from '../../lib/run-labels'
import { pathAfterClosingTab } from '../../lib/workspace-tabs'
import type { Job } from '../../types'
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

/**
 * Open-run tabs. Home (the composer) is not a tab — Recents switch
 * conversations, this strip is the jobs you are watching.
 */
export default function WorkspaceTabsBar() {
  const navigate = useNavigate()
  const { tabs, activePath, closeTab, clearTabs } = useWorkspaceTabs()
  const { jobs } = useJobs(5000)

  const jobsById = useMemo(() => {
    const map = new Map<string, Job>()
    for (const job of jobs) map.set(job.id, job)
    return map
  }, [jobs])

  if (tabs.length === 0) return null

  function closeAndNavigate(path: string) {
    const next = pathAfterClosingTab(tabs, path, activePath)
    closeTab(path)
    if (next) navigate(next)
  }

  return (
    <div className="border-b border-line bg-panel/55 backdrop-blur-xl">
      <div className="flex items-stretch gap-1 px-3 lg:px-6">
        <ScrollArea className="min-w-0 flex-1 whitespace-nowrap">
          <div className="flex items-stretch">
            {tabs.map(tab => {
              const active = activePath === tab.path
              const job = jobsById.get(tab.id)
              const jobStatus = job ? getTabStatus(job) : null
              const secondary = jobStatus?.label
              const tooltip = jobStatus ? `${tab.title} — ${jobStatus.label}` : tab.title
              return (
                <div
                  key={tab.path}
                  className={cn(
                    'group relative -mb-px flex h-10 max-w-[240px] items-center gap-2 border-b-2 px-3 transition-[color,border-color]',
                    active
                      ? 'border-accent-400 text-fg'
                      : 'border-transparent text-fg-muted hover:text-fg',
                  )}
                >
                  {jobStatus ? (
                    <span
                      className={cn(
                        'size-2 shrink-0 rounded-full',
                        toneDotClasses(jobStatus.tone),
                        jobStatus.pulse && 'animate-pulse-dot',
                      )}
                      aria-hidden
                    />
                  ) : null}
                  <Link
                    to={tab.path}
                    className="flex min-w-0 flex-col justify-center leading-tight focus-visible:outline-none"
                    title={tooltip}
                  >
                    <span className="truncate text-sm font-medium">{tab.title}</span>
                    {secondary ? (
                      <span
                        className={cn(
                          'truncate text-[10px]',
                          jobStatus?.attention ? 'text-warning-400' : 'text-fg-subtle',
                        )}
                      >
                        {secondary}
                      </span>
                    ) : null}
                  </Link>
                  <button
                    type="button"
                    onClick={() => closeAndNavigate(tab.path)}
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
                  clearTabs()
                  navigate(HOME_PATH)
                }}
              >
                <PanelTopClose className="size-4" />
                Close all tabs
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {tabs.map(tab => {
                const job = jobsById.get(tab.id)
                const jobStatus = job ? getTabStatus(job) : null
                return (
                  <DropdownMenuItem key={tab.path} onClick={() => navigate(tab.path)}>
                    {jobStatus ? (
                      <span
                        className={cn(
                          'size-2 shrink-0 rounded-full',
                          toneDotClasses(jobStatus.tone),
                          jobStatus.pulse && 'animate-pulse-dot',
                        )}
                        aria-hidden
                      />
                    ) : null}
                    <span className="truncate">{tab.title}</span>
                    {jobStatus ? (
                      <span className="ml-auto pl-3 text-[10px] text-fg-subtle">
                        {jobStatus.label}
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  )
}
