import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Layers3, PlayCircle, Search } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import PageHeader from '../components/common/page-header'
import EmptyState from '../components/common/empty-state'
import ErrorState from '../components/common/error-state'
import StatusBadge from '../components/StatusBadge'
import { Button } from '../components/ui/button'
import { Card, CardContent } from '../components/ui/card'
import { Input } from '../components/ui/input'
import SegmentedControl from '../components/ui/segmented-control'
import { Skeleton } from '../components/ui/skeleton'
import { formatPreciseCurrency, formatRelativeTime } from '../lib/format'
import {
  deriveJobDescription,
  deriveJobTitle,
  deriveWorkflowLabel,
  getCurrentWorkItem,
  getRepoSlug,
  getRunDetailPath,
  isCampaignJob,
  sortJobsByUpdatedAt,
} from '../lib/jobs'
import { isTerminalStatus, isWaitingStatus } from '../lib/status'
import { useJobs } from '../hooks/useJobs'
import type { Job } from '../types'

type StatusFilter = 'active' | 'waiting' | 'all' | 'terminal'
type KindFilter = 'all' | 'job' | 'campaign'

const STATUS_FILTERS = [
  { value: 'active' as const, label: 'Active' },
  { value: 'waiting' as const, label: 'Awaiting' },
  { value: 'terminal' as const, label: 'Finished' },
  { value: 'all' as const, label: 'All' },
]

const KIND_FILTERS = [
  { value: 'all' as const, label: 'All' },
  { value: 'job' as const, label: 'Jobs' },
  { value: 'campaign' as const, label: 'Campaigns' },
]

interface CampaignProgress {
  total: number
  done: number
  active: number
  blocked: number
}

function getCampaignProgress(job: Job): CampaignProgress {
  const children = job.campaignChildren ?? []
  return children.reduce<CampaignProgress>(
    (acc, child) => {
      acc.total += 1
      if (child.status === 'complete' || child.status === 'skipped') acc.done += 1
      if (child.status === 'ready' || child.status === 'dispatched') acc.active += 1
      if (child.status === 'failed' || child.status === 'escalated') acc.blocked += 1
      return acc
    },
    { total: 0, done: 0, active: 0, blocked: 0 },
  )
}

function getRunFocus(job: Job): string {
  if (!isCampaignJob(job)) return getCurrentWorkItem(job)

  const progress = getCampaignProgress(job)
  if (progress.total === 0) return 'Planning child graph'

  const segments = [`${progress.done}/${progress.total} done`]
  if (progress.active > 0) segments.push(`${progress.active} active`)
  if (progress.blocked > 0) segments.push(`${progress.blocked} blocked`)
  return segments.join(' · ')
}

export default function JobList() {
  const location = useLocation()
  const { jobs, loading, error } = useJobs()
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
  const defaultKind = location.pathname.startsWith('/campaigns') ? 'campaign' : 'all'
  const [kindFilter, setKindFilter] = useState<KindFilter>(defaultKind)

  useEffect(() => {
    setKindFilter(defaultKind)
  }, [defaultKind])

  const runs = useMemo(() => sortJobsByUpdatedAt(jobs), [jobs])
  const visibleRuns = useMemo(() => {
    const search = query.trim().toLowerCase()

    return runs.filter(job => {
      if (kindFilter === 'job' && isCampaignJob(job)) return false
      if (kindFilter === 'campaign' && !isCampaignJob(job)) return false

      if (statusFilter === 'active' && isTerminalStatus(job.status)) return false
      if (statusFilter === 'waiting' && !isWaitingStatus(job.status)) return false
      if (statusFilter === 'terminal' && !isTerminalStatus(job.status)) return false

      if (!search) return true

      const haystack = [
        job.id,
        deriveJobTitle(job),
        deriveJobDescription(job),
        getRepoSlug(job),
        job.phase,
        getRunFocus(job),
        deriveWorkflowLabel(job.workflowPath),
        job.workflowPath,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return haystack.includes(search)
    })
  }, [runs, query, statusFilter, kindFilter])

  const activeCount = runs.filter(job => !isTerminalStatus(job.status)).length
  const waitingCount = runs.filter(job => isWaitingStatus(job.status)).length

  const isCampaignsRoute = location.pathname.startsWith('/campaigns')
  const pageTitle = isCampaignsRoute ? 'Campaigns' : 'Runs'
  const pageDescription = isCampaignsRoute
    ? 'Campaigns currently scheduled, in motion, or finished.'
    : 'All jobs and campaigns in one place. Filter to change the lens.'

  return (
    <div className="space-y-6">
      <PageHeader
        title={pageTitle}
        description={pageDescription}
        actions={
          <Button asChild>
            <Link to="/jobs/new">
              New run
              <ArrowRight />
            </Link>
          </Button>
        }
      />

      <Card>
        <div className="flex flex-col gap-4 border-b border-line p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              options={KIND_FILTERS}
              value={kindFilter}
              onChange={setKindFilter}
              size="sm"
              ariaLabel="Filter by kind"
            />
            <SegmentedControl
              options={STATUS_FILTERS}
              value={statusFilter}
              onChange={setStatusFilter}
              size="sm"
              ariaLabel="Filter by status"
            />
          </div>

          <div className="flex items-center gap-3">
            <div className="relative w-full lg:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
              <Input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Search runs"
                className="h-9 pl-9 text-[13px]"
              />
            </div>
            <span className="hidden whitespace-nowrap text-[11px] uppercase tracking-[0.14em] text-fg-subtle sm:inline">
              {visibleRuns.length} / {runs.length}
              <span className="ml-2 text-fg-subtle/70">
                · {activeCount} active · {waitingCount} awaiting
              </span>
            </span>
          </div>
        </div>

        <CardContent className="p-0">
          {error ? (
            <div className="p-4">
              <ErrorState title="Could not load runs" message={error} />
            </div>
          ) : loading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-14 w-full" />
              ))}
            </div>
          ) : visibleRuns.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={PlayCircle}
                title="No runs match the current view"
                description="Create a run or widen the filters to bring more work into view."
                action={
                  <Button asChild>
                    <Link to="/jobs/new">Create run</Link>
                  </Button>
                }
              />
            </div>
          ) : (
            <RunsTable runs={visibleRuns} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function RunsTable({ runs }: { runs: Job[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.16em] text-fg-subtle">
            <th className="px-4 py-3 font-medium">Run</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Working on</th>
            <th className="px-4 py-3 font-medium">Updated</th>
            <th className="px-4 py-3 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {runs.map(job => (
            <tr key={job.id} className="group transition-colors hover:bg-overlay/40">
              <td className="px-4 py-3">
                <Link to={getRunDetailPath(job)} className="block min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-fg group-hover:text-accent-300">
                      {deriveJobTitle(job)}
                    </span>
                    {isCampaignJob(job) ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-md border border-line bg-overlay px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-fg-muted"
                        title="Campaign"
                      >
                        <Layers3 className="size-2.5" />
                        Campaign
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate text-[12px] text-fg-subtle">
                    {[deriveWorkflowLabel(job.workflowPath), getRepoSlug(job)].filter(Boolean).join(' · ')}
                  </div>
                </Link>
              </td>
              <td className="px-4 py-3 align-top">
                <StatusBadge status={job.status} />
              </td>
              <td className="px-4 py-3 align-top text-fg-muted">
                <div className="line-clamp-1 text-[13px]">{getRunFocus(job)}</div>
                <div className="text-[11px] text-fg-subtle">phase: {job.phase}</div>
              </td>
              <td className="whitespace-nowrap px-4 py-3 align-top text-[13px] text-fg-muted">
                {formatRelativeTime(job.updatedAt)}
              </td>
              <td className="whitespace-nowrap px-4 py-3 align-top text-right tabular-nums text-fg-muted">
                {formatPreciseCurrency(job.tokenUsage?.totalCostUsd ?? 0)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
