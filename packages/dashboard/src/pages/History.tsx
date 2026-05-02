import { useMemo, useState } from 'react'
import { History as HistoryIcon, ListFilter, ShieldCheck, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import PageHeader from '../components/common/page-header'
import StatCard from '../components/common/stat-card'
import EmptyState from '../components/common/empty-state'
import StatusBadge from '../components/StatusBadge'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Skeleton } from '../components/ui/skeleton'
import { formatPreciseCurrency, formatRelativeTime } from '../lib/format'
import { deriveJobDescription, deriveJobTitle, isCampaignJob, sortJobsByUpdatedAt } from '../lib/jobs'
import { isTerminalStatus } from '../lib/status'
import { useJobs } from '../hooks/useJobs'

type ScopeFilter = 'all' | 'jobs' | 'campaigns'
type OutcomeFilter = 'all' | 'complete' | 'failed' | 'escalated'

const SCOPE_FILTERS: ScopeFilter[] = ['all', 'jobs', 'campaigns']
const OUTCOME_FILTERS: OutcomeFilter[] = ['all', 'complete', 'failed', 'escalated']

export default function History() {
  const { jobs, loading, error } = useJobs()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<ScopeFilter>('all')
  const [outcome, setOutcome] = useState<OutcomeFilter>('all')

  const terminalJobs = useMemo(() => sortJobsByUpdatedAt(jobs.filter(job => isTerminalStatus(job.status))), [jobs])

  const visibleJobs = useMemo(() => {
    const search = query.trim().toLowerCase()

    return terminalJobs.filter(job => {
      if (scope === 'jobs' && isCampaignJob(job)) return false
      if (scope === 'campaigns' && !isCampaignJob(job)) return false
      if (outcome !== 'all' && job.status !== outcome) return false

      if (!search) return true

      const haystack = [job.id, deriveJobTitle(job), deriveJobDescription(job), job.phase]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return haystack.includes(search)
    })
  }, [terminalJobs, query, scope, outcome])

  const completedCount = terminalJobs.filter(job => job.status === 'complete').length
  const failedCount = terminalJobs.filter(job => job.status === 'failed').length
  const escalatedCount = terminalJobs.filter(job => job.status === 'escalated').length

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Run Archive"
        title="History"
        description="Review completed, failed, and escalated work across jobs and campaigns without leaving the operator shell."
      />

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Completed" value={completedCount.toString()} description="Successful runs across all workflows." icon={ShieldCheck} tone="emerald" />
        <StatCard label="Failed" value={failedCount.toString()} description="Runs that stopped on a failure." icon={TriangleAlert} tone="rose" />
        <StatCard label="Archived" value={terminalJobs.length.toString()} description={`${escalatedCount} ended with escalation.`} icon={HistoryIcon} tone="neutral" />
      </div>

      <Card>
        <CardHeader className="gap-4 border-b border-white/8 pb-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-1.5">
              <CardTitle>Terminal Runs</CardTitle>
              <p className="text-sm text-slate-400">History is filtered entirely client-side from the current jobs API, keeping the view frontend-only.</p>
            </div>
            <div className="w-full lg:w-80">
              <Input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search archived work" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/4 p-1">
              {SCOPE_FILTERS.map(item => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setScope(item)}
                  className={`rounded-full px-3 py-1.5 text-sm capitalize transition-colors ${scope === item ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}
                >
                  {item}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 rounded-full border border-white/8 bg-white/4 p-1">
              {OUTCOME_FILTERS.map(item => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setOutcome(item)}
                  className={`rounded-full px-3 py-1.5 text-sm capitalize transition-colors ${outcome === item ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}
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
              Failed to load history: {error}
            </div>
          ) : loading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-20 w-full" />)}
            </div>
          ) : visibleJobs.length === 0 ? (
            <EmptyState
              icon={HistoryIcon}
              title="No archived runs match the current filters"
              description="Adjust the filters or wait for current work to finish and it will appear here automatically."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] table-fixed border-separate border-spacing-y-2">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-[0.16em] text-slate-500">
                    <th className="pb-2 font-medium">Run</th>
                    <th className="pb-2 font-medium">Outcome</th>
                    <th className="pb-2 font-medium">Phase</th>
                    <th className="pb-2 font-medium">Updated</th>
                    <th className="pb-2 font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleJobs.map(job => {
                    const detailPath = isCampaignJob(job) ? `/campaigns/${job.id}` : `/jobs/${job.id}`

                    return (
                      <tr key={job.id} className="rounded-2xl bg-white/[0.03] text-sm text-slate-200">
                        <td className="rounded-l-2xl border-y border-l border-white/8 px-4 py-3">
                          <Link to={detailPath} className="block space-y-1 hover:text-white">
                            <div className="font-medium text-white">{deriveJobTitle(job)}</div>
                            <div className="truncate text-xs uppercase tracking-[0.14em] text-slate-500">{job.id}</div>
                            {deriveJobDescription(job) ? <div className="line-clamp-1 text-sm text-slate-400">{deriveJobDescription(job)}</div> : null}
                          </Link>
                        </td>
                        <td className="border-y border-white/8 px-4 py-3"><StatusBadge status={job.status} /></td>
                        <td className="border-y border-white/8 px-4 py-3 text-slate-300">{job.phase}</td>
                        <td className="border-y border-white/8 px-4 py-3 text-slate-300">{formatRelativeTime(job.updatedAt)}</td>
                        <td className="rounded-r-2xl border-y border-r border-white/8 px-4 py-3 text-slate-300">{formatPreciseCurrency(job.tokenUsage?.totalCostUsd ?? 0)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}