import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, CirclePause, Layers3, ListFilter, PlayCircle } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import PageHeader from '../components/common/page-header'
import StatCard from '../components/common/stat-card'
import EmptyState from '../components/common/empty-state'
import StatusBadge from '../components/StatusBadge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Skeleton } from '../components/ui/skeleton'
import { formatPreciseCurrency, formatRelativeTime } from '../lib/format'
import {
  deriveJobDescription,
  deriveJobTitle,
  deriveWorkflowLabel,
  getCurrentWorkItem,
  getRepoSlug,
  getRunDetailPath,
  getRunKindLabel,
  isCampaignJob,
  sortJobsByUpdatedAt,
} from '../lib/jobs'
import { isTerminalStatus, isWaitingStatus } from '../lib/status'
import { useJobs } from '../hooks/useJobs'
import type { Job } from '../types'

type StatusFilter = 'active' | 'waiting' | 'all' | 'terminal'
type KindFilter = 'all' | 'job' | 'campaign'

const STATUS_FILTERS: StatusFilter[] = ['active', 'waiting', 'all', 'terminal']
const KIND_FILTERS: KindFilter[] = ['all', 'job', 'campaign']

interface CampaignProgress {
  total: number
  done: number
  active: number
  blocked: number
}

function getCampaignProgress(job: Job): CampaignProgress {
  const children = job.campaignChildren ?? []

  return children.reduce<CampaignProgress>((acc, child) => {
    acc.total += 1
    if (child.status === 'complete' || child.status === 'skipped') acc.done += 1
    if (child.status === 'ready' || child.status === 'dispatched') acc.active += 1
    if (child.status === 'failed' || child.status === 'escalated') acc.blocked += 1
    return acc
  }, { total: 0, done: 0, active: 0, blocked: 0 })
}

function getRunFocus(job: Job): string {
  if (!isCampaignJob(job)) {
    return getCurrentWorkItem(job)
  }

  const progress = getCampaignProgress(job)
  if (progress.total === 0) return 'Planning child graph'

  const segments = [`${progress.done}/${progress.total} complete`]
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
  const campaignCount = runs.filter(isCampaignJob).length
  const totalSpend = runs.reduce((sum, job) => sum + (job.tokenUsage?.totalCostUsd ?? 0), 0)

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Run Inventory"
        title="Runs"
        description="One registry for jobs and campaigns, with filters to change the lens instead of the entity."
        actions={
          <Button asChild>
            <Link to="/jobs/new">
              New Run
              <ArrowRight />
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Active Runs" value={activeCount.toString()} description="All non-terminal runs across jobs and campaigns." icon={PlayCircle} tone="indigo" />
        <StatCard label="Awaiting" value={waitingCount.toString()} description="Runs waiting for people, plans, merges, or external events." icon={CirclePause} tone="amber" />
        <StatCard label="Campaign Runs" value={campaignCount.toString()} description={`${formatPreciseCurrency(totalSpend)} total spend across all runs.`} icon={Layers3} tone="cyan" />
      </div>

      <Card>
        <CardHeader className="gap-4 border-b border-white/8 pb-4">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="space-y-3">
              <CardTitle>Run Registry</CardTitle>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/4 p-1">
                  {KIND_FILTERS.map(item => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setKindFilter(item)}
                      className={`rounded-full px-3 py-1.5 text-sm capitalize transition-colors ${kindFilter === item ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}
                    >
                      {item === 'campaign' ? 'campaigns' : item}
                    </button>
                  ))}
                </div>

                <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/4 p-1">
                  {STATUS_FILTERS.map(item => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setStatusFilter(item)}
                      className={`rounded-full px-3 py-1.5 text-sm capitalize transition-colors ${statusFilter === item ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex w-full flex-col gap-3 xl:w-[360px] xl:items-end">
              <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by run, repo, workflow, or work item" />
              <div className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-slate-500">
                <ListFilter className="size-3.5" />
                {visibleRuns.length} visible
              </div>
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-5">
          {error ? (
            <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              Failed to load runs: {error}
            </div>
          ) : loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-20 w-full" />)}
            </div>
          ) : visibleRuns.length === 0 ? (
            <EmptyState
              icon={PlayCircle}
              title="No runs match the current view"
              description="Create a run or widen the filters to bring more work into view."
              action={<Button asChild><Link to="/jobs/new">Create run</Link></Button>}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1120px] table-fixed border-separate border-spacing-y-2">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-[0.16em] text-slate-500">
                    <th className="pb-2 font-medium">Run</th>
                    <th className="pb-2 font-medium">Type</th>
                    <th className="pb-2 font-medium">Status</th>
                    <th className="pb-2 font-medium">Workflow</th>
                    <th className="pb-2 font-medium">Phase</th>
                    <th className="pb-2 font-medium">Focus</th>
                    <th className="pb-2 font-medium">Updated</th>
                    <th className="pb-2 font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRuns.map(job => (
                    <tr key={job.id} className="rounded-2xl bg-white/[0.03] text-sm text-slate-200">
                      <td className="rounded-l-2xl border-y border-l border-white/8 px-4 py-3">
                        <Link to={getRunDetailPath(job)} className="block space-y-1 hover:text-white">
                          <div className="font-medium text-white">{deriveJobTitle(job)}</div>
                          <div className="truncate text-xs uppercase tracking-[0.14em] text-slate-500">{job.id}</div>
                          {deriveJobDescription(job) ? <div className="line-clamp-1 text-sm text-slate-400">{deriveJobDescription(job)}</div> : null}
                        </Link>
                      </td>
                      <td className="border-y border-white/8 px-4 py-3">
                        <span className="inline-flex rounded-full border border-white/8 bg-white/4 px-2.5 py-1 text-[11px] uppercase tracking-[0.14em] text-slate-300">
                          {getRunKindLabel(job)}
                        </span>
                      </td>
                      <td className="border-y border-white/8 px-4 py-3"><StatusBadge status={job.status} /></td>
                      <td className="border-y border-white/8 px-4 py-3">
                        <div className="space-y-1">
                          <div className="text-slate-100">{deriveWorkflowLabel(job.workflowPath)}</div>
                          <div className="truncate text-xs text-slate-500">{getRepoSlug(job) ?? job.workflowPath}</div>
                        </div>
                      </td>
                      <td className="border-y border-white/8 px-4 py-3 text-slate-300">{job.phase}</td>
                      <td className="border-y border-white/8 px-4 py-3 text-slate-300">{getRunFocus(job)}</td>
                      <td className="border-y border-white/8 px-4 py-3 text-slate-300">{formatRelativeTime(job.updatedAt)}</td>
                      <td className="rounded-r-2xl border-y border-r border-white/8 px-4 py-3 text-slate-300">{formatPreciseCurrency(job.tokenUsage?.totalCostUsd ?? 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
