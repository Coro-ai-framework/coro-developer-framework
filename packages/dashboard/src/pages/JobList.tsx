import { useMemo, useState } from 'react'
import { ArrowRight, Bot, CirclePause, ListFilter, PlayCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import PageHeader from '../components/common/page-header'
import StatCard from '../components/common/stat-card'
import EmptyState from '../components/common/empty-state'
import StatusBadge from '../components/StatusBadge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Skeleton } from '../components/ui/skeleton'
import { formatPreciseCurrency, formatRelativeTime } from '../lib/format'
import { deriveJobDescription, deriveJobTitle, getCurrentWorkItem, getRepoSlug, isCampaignJob, sortJobsByUpdatedAt } from '../lib/jobs'
import { isTerminalStatus, isWaitingStatus } from '../lib/status'
import { useJobs } from '../hooks/useJobs'

type JobFilter = 'active' | 'waiting' | 'all' | 'terminal'

const FILTERS: JobFilter[] = ['active', 'waiting', 'all', 'terminal']

export default function JobList() {
  const { jobs, loading, error } = useJobs()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<JobFilter>('active')

  const workItems = useMemo(() => sortJobsByUpdatedAt(jobs.filter(job => !isCampaignJob(job))), [jobs])
  const visibleJobs = useMemo(() => {
    const search = query.trim().toLowerCase()

    return workItems.filter(job => {
      if (filter === 'active' && isTerminalStatus(job.status)) return false
      if (filter === 'waiting' && !isWaitingStatus(job.status)) return false
      if (filter === 'terminal' && !isTerminalStatus(job.status)) return false

      if (!search) return true

      const haystack = [job.id, deriveJobTitle(job), deriveJobDescription(job), getRepoSlug(job), job.phase, getCurrentWorkItem(job)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return haystack.includes(search)
    })
  }, [workItems, query, filter])

  const activeCount = workItems.filter(job => !isTerminalStatus(job.status)).length
  const waitingCount = workItems.filter(job => isWaitingStatus(job.status)).length
  const totalSpend = workItems.reduce((sum, job) => sum + (job.tokenUsage?.totalCostUsd ?? 0), 0)

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Run Inventory"
        title="Jobs"
        description="Monitor live work items, filter by state, and jump directly into the jobs that need attention."
        actions={
          <Button asChild>
            <Link to="/jobs/new">
              New Job
              <ArrowRight />
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Active Jobs" value={activeCount.toString()} description="Non-terminal work items in the system." icon={PlayCircle} tone="indigo" />
        <StatCard label="Awaiting" value={waitingCount.toString()} description="Jobs waiting for people, plans, or merges." icon={CirclePause} tone="amber" />
        <StatCard label="Spend" value={formatPreciseCurrency(totalSpend)} description="Total spend across all non-campaign jobs." icon={Bot} tone="cyan" />
      </div>

      <Card>
        <CardHeader className="gap-4 border-b border-white/8 pb-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-1.5">
              <CardTitle>Job Monitor</CardTitle>
              <p className="text-sm text-slate-400">The list is built from the full job payload, which keeps filtering and status insight client-side and fast.</p>
            </div>
            <div className="w-full lg:w-80">
              <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by job, repo, or work item" />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/4 p-1">
              {FILTERS.map(item => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setFilter(item)}
                  className={`rounded-full px-3 py-1.5 text-sm capitalize transition-colors ${filter === item ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-slate-500">
              <ListFilter className="size-3.5" />
              {visibleJobs.length} visible
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-5">
          {error ? (
            <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
              Failed to load jobs: {error}
            </div>
          ) : loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-20 w-full" />)}
            </div>
          ) : visibleJobs.length === 0 ? (
            <EmptyState
              icon={PlayCircle}
              title="No jobs match the current view"
              description="Dispatch a new job or widen the filters to bring more work into view."
              action={<Button asChild><Link to="/jobs/new">Dispatch job</Link></Button>}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] table-fixed border-separate border-spacing-y-2">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-[0.16em] text-slate-500">
                    <th className="pb-2 font-medium">Job</th>
                    <th className="pb-2 font-medium">Status</th>
                    <th className="pb-2 font-medium">Phase</th>
                    <th className="pb-2 font-medium">Current Work</th>
                    <th className="pb-2 font-medium">Updated</th>
                    <th className="pb-2 font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleJobs.map(job => (
                    <tr key={job.id} className="rounded-2xl bg-white/[0.03] text-sm text-slate-200">
                      <td className="rounded-l-2xl border-y border-l border-white/8 px-4 py-3">
                        <Link to={`/jobs/${job.id}`} className="block space-y-1 hover:text-white">
                          <div className="font-medium text-white">{deriveJobTitle(job)}</div>
                          <div className="truncate text-xs uppercase tracking-[0.14em] text-slate-500">{job.id}</div>
                          {deriveJobDescription(job) ? <div className="line-clamp-1 text-sm text-slate-400">{deriveJobDescription(job)}</div> : null}
                        </Link>
                      </td>
                      <td className="border-y border-white/8 px-4 py-3"><StatusBadge status={job.status} /></td>
                      <td className="border-y border-white/8 px-4 py-3 text-slate-300">{job.phase}</td>
                      <td className="border-y border-white/8 px-4 py-3 text-slate-300">{getCurrentWorkItem(job)}</td>
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
