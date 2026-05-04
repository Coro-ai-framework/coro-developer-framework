import { useMemo, useState } from 'react'
import { History as HistoryIcon, Search } from 'lucide-react'
import { Link } from 'react-router-dom'
import PageHeader from '../components/common/page-header'
import EmptyState from '../components/common/empty-state'
import ErrorState from '../components/common/error-state'
import StatusBadge from '../components/StatusBadge'
import { Card, CardContent } from '../components/ui/card'
import { Input } from '../components/ui/input'
import SegmentedControl from '../components/ui/segmented-control'
import { Skeleton } from '../components/ui/skeleton'
import { formatPreciseCurrency, formatRelativeTime } from '../lib/format'
import { deriveJobDescription, deriveJobTitle, getRunDetailPath, sortJobsByUpdatedAt } from '../lib/jobs'
import {
  PAGE_TITLES,
  RUN_NOUN,
  deriveWorkflowFilterOptions,
  getRunWorkflowTag,
  getWorkflowSlug,
} from '../lib/run-labels'
import { isTerminalStatus } from '../lib/status'
import { useJobs } from '../hooks/useJobs'

type OutcomeFilter = 'all' | 'complete' | 'failed' | 'escalated'

const OUTCOME_FILTERS = [
  { value: 'all' as const, label: 'All outcomes' },
  { value: 'complete' as const, label: 'Complete' },
  { value: 'failed' as const, label: 'Failed' },
  { value: 'escalated' as const, label: 'Escalated' },
]

export default function History() {
  const { jobs, loading, error } = useJobs()
  const [query, setQuery] = useState('')
  const [workflowFilter, setWorkflowFilter] = useState<string>('all')
  const [outcome, setOutcome] = useState<OutcomeFilter>('all')

  const terminalJobs = useMemo(
    () => sortJobsByUpdatedAt(jobs.filter(job => isTerminalStatus(job.status))),
    [jobs],
  )

  const workflowOptions = useMemo(() => deriveWorkflowFilterOptions(terminalJobs), [terminalJobs])

  const visibleJobs = useMemo(() => {
    const search = query.trim().toLowerCase()

    return terminalJobs.filter(job => {
      if (workflowFilter !== 'all' && getWorkflowSlug(job.workflowPath) !== workflowFilter) return false
      if (outcome !== 'all' && job.status !== outcome) return false

      if (!search) return true

      const haystack = [job.id, deriveJobTitle(job), deriveJobDescription(job), job.phase]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return haystack.includes(search)
    })
  }, [terminalJobs, query, workflowFilter, outcome])

  const completedCount = terminalJobs.filter(job => job.status === 'complete').length
  const failedCount = terminalJobs.filter(job => job.status === 'failed').length
  const escalatedCount = terminalJobs.filter(job => job.status === 'escalated').length

  return (
    <div className="space-y-6">
      <PageHeader
        title={PAGE_TITLES.history}
        description={`Completed, failed, and escalated ${RUN_NOUN.pluralLower}. ${completedCount} done · ${failedCount} failed · ${escalatedCount} escalated.`}
      />

      <Card>
        <div className="flex flex-col gap-4 border-b border-line p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              options={workflowOptions}
              value={workflowFilter}
              onChange={setWorkflowFilter}
              size="sm"
              ariaLabel="Filter by workflow"
            />
            <SegmentedControl
              options={OUTCOME_FILTERS}
              value={outcome}
              onChange={setOutcome}
              size="sm"
              ariaLabel="Filter by outcome"
            />
          </div>

          <div className="flex items-center gap-3">
            <div className="relative w-full lg:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
              <Input
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={`Search archived ${RUN_NOUN.pluralLower}`}
                className="h-9 pl-9 text-[13px]"
              />
            </div>
            <span className="hidden whitespace-nowrap text-[11px] uppercase tracking-[0.14em] text-fg-subtle sm:inline">
              {visibleJobs.length} / {terminalJobs.length}
            </span>
          </div>
        </div>

        <CardContent className="p-0">
          {error ? (
            <div className="p-4">
              <ErrorState title="Could not load history" message={error} />
            </div>
          ) : loading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-14 w-full" />
              ))}
            </div>
          ) : visibleJobs.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={HistoryIcon}
                title={`No archived ${RUN_NOUN.pluralLower} match the current filters`}
                description="Adjust the filters or wait for current work to finish."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.16em] text-fg-subtle">
                    <th className="px-4 py-3 font-medium">{RUN_NOUN.singular}</th>
                    <th className="px-4 py-3 font-medium">Workflow</th>
                    <th className="px-4 py-3 font-medium">Outcome</th>
                    <th className="px-4 py-3 font-medium">Phase</th>
                    <th className="px-4 py-3 font-medium">Updated</th>
                    <th className="px-4 py-3 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {visibleJobs.map(job => {
                    const detailPath = getRunDetailPath(job)
                    return (
                      <tr key={job.id} className="group transition-colors hover:bg-overlay/40">
                        <td className="px-4 py-3">
                          <Link to={detailPath} className="block min-w-0 space-y-0.5">
                            <div className="truncate font-medium text-fg group-hover:text-accent-300">
                              {deriveJobTitle(job)}
                            </div>
                            {deriveJobDescription(job) ? (
                              <div className="line-clamp-1 text-[12px] text-fg-subtle">
                                {deriveJobDescription(job)}
                              </div>
                            ) : null}
                          </Link>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <span className="inline-flex items-center rounded-md border border-line bg-overlay px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.12em] text-fg-muted">
                            {getRunWorkflowTag(job)}
                          </span>
                        </td>
                        <td className="px-4 py-3 align-top">
                          <StatusBadge status={job.status} />
                        </td>
                        <td className="px-4 py-3 align-top text-[13px] text-fg-muted">{job.phase}</td>
                        <td className="whitespace-nowrap px-4 py-3 align-top text-[13px] text-fg-muted">
                          {formatRelativeTime(job.updatedAt)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 align-top text-right tabular-nums text-fg-muted">
                          {formatPreciseCurrency(job.tokenUsage?.totalCostUsd ?? 0)}
                        </td>
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
