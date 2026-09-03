import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { MoreHorizontal, PanelTopClose, X } from 'lucide-react'
import { usePlanSession } from '../../providers/plan-session'
import { useWorkspaceTabs } from '../../providers/workspace-tabs'
import { useJobs } from '../../hooks/useJobs'
import { getStatusMeta, isPausedStatus, toneDotClasses, type Tone } from '../../lib/status'
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

function fallbackRoute() {
  return '/jobs'
}

interface TabJobStatus {
  label: string
  tone: Tone
  pulse: boolean
  /** Needs the developer's attention (escalated / awaiting input / paused). */
  attention: boolean
}

/**
 * Collapse a live job into the compact status signal shown on its tab:
 * a tone (drives the dot color), a short label (the phase or wait reason),
 * whether it should pulse, and whether it's asking for the developer.
 */
function deriveTabJobStatus(job: Job): TabJobStatus {
  // Developer-initiated pause is a deliberate stop — flag it for attention
  // (amber label) but keep the dot calm (no pulse).
  if (isPausedStatus(job.status, job.awaitingEvent)) {
    return { label: 'Paused', tone: 'warning', pulse: false, attention: true }
  }
  const meta = getStatusMeta(job.status)
  const attention = meta.category === 'waiting' || job.status === 'escalated'
  // Rate-limit is a passive countdown (waiting for the window to reset), so
  // keep its dot calm like Paused — flag attention, but don't pulse.
  const calmWait = job.status === 'awaiting-rate-limit'
  // Pulse while running, and for any "needs you" state, so the eye catches it.
  const pulse = !calmWait && ((meta.pulse ?? false) || attention)
  return { label: meta.label, tone: meta.tone, pulse, attention }
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
  const { jobs } = useJobs(5000)
  const session = usePlanSession()

  const jobsById = useMemo(() => {
    const map = new Map<string, Job>()
    for (const job of jobs) map.set(job.id, job)
    return map
  }, [jobs])

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
              const job = jobsById.get(tab.id)
              const jobStatus = job ? deriveTabJobStatus(job) : null
              // Live job status wins for the secondary line; otherwise fall
              // back to the static subtitle stored on the tab (e.g. the New
              // Run draft shows its repo/service-name hint).
              const secondary = jobStatus?.label ?? tab.subtitle
              const tooltip = jobStatus
                ? `${tab.title} — ${jobStatus.label}`
                : tab.title
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
                    onClick={() => {
                      const wasActive = activePath === tab.path
                      if (tab.path === '/jobs/new') {
                        if (session.busy) {
                          const ok = window.confirm(
                            'Coro is still working in the background. Close this tab? The conversation stays in history.',
                          )
                          if (!ok) return
                        }
                      }
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
                  if (session.busy) {
                    const ok = window.confirm(
                      'Coro is still working in the background. Close all tabs? The conversation stays in history.',
                    )
                    if (!ok) return
                  }
                  clearTabs()
                  navigate('/jobs')
                }}
              >
                <PanelTopClose className="size-4" />
                Close all tabs
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {tabs.map(tab => {
                const job = jobsById.get(tab.id)
                const jobStatus = job ? deriveTabJobStatus(job) : null
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
