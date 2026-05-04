import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Layers3, PlayCircle, Search } from 'lucide-react'
import { Link, useSearchParams } from 'react-router-dom'
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
import {
  PAGE_TITLES,
  RUN_NOUN,
  SUB_RUN_NOUN,
  deriveWorkflowFilterOptions,
  getRunWorkflowTag,
  getWorkflowSlug,
  hostsSubRuns,
} from '../lib/run-labels'
import { isTerminalStatus, isWaitingStatus } from '../lib/status'
import { useJobs } from '../hooks/useJobs'
import type { Job } from '../types'

type StatusFilter = 'active' | 'waiting' | 'all' | 'terminal'

const STATUS_FILTERS = [
  { value: 'active' as const, label: 'Active' },
  { value: 'waiting' as const, label: 'Awaiting' },
  { value: 'terminal' as const, label: 'Finished' },
  { value: 'all' as const, label: 'All' },
]

interface SubRunProgress {
  total: number
  done: number
  active: number
  blocked: number
}

function getSubRunProgress(job: Job): SubRunProgress {
  const subRuns = job.campaignChildren ?? []
  return subRuns.reduce<SubRunProgress>(
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
  if (!hostsSubRuns(job)) return getCurrentWorkItem(job)

  const progress = getSubRunProgress(job)
  if (progress.total === 0) return `Planning ${SUB_RUN_NOUN.singularLower} graph`

  const segments = [`${progress.done}/${progress.total} done`]
  if (progress.active > 0) segments.push(`${progress.active} active`)
  if (progress.blocked > 0) segments.push(`${progress.blocked} blocked`)
  return segments.join(' · ')
}

export default function JobList() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { jobs, loading, error } = useJobs()
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')

  const runs = useMemo(() => sortJobsByUpdatedAt(jobs), [jobs])
  const workflowOptions = useMemo(() => deriveWorkflowFilterOptions(runs), [runs])

  const initialWorkflow = searchParams.get('workflow') ?? 'all'
  const [workflowFilter, setWorkflowFilter] = useState<string>(initialWorkflow)

  // Sync the workflow filter into the URL so /campaigns redirect targets
  // (?workflow=campaign) and external deep-links keep working without UI
  // duplication.
  useEffect(() => {
    const current = searchParams.get('workflow') ?? 'all'
    if (current !== workflowFilter) {
      const next = new URLSearchParams(searchParams)
      if (workflowFilter === 'all') next.delete('workflow')
      else next.set('workflow', workflowFilter)
      setSearchParams(next, { replace: true })
    }
  }, [workflowFilter, searchParams, setSearchParams])

  // If the URL changes (e.g. via /campaigns alias redirect), reflect it.
  useEffect(() => {
    const current = searchParams.get('workflow') ?? 'all'
    if (current !== workflowFilter) {
      setWorkflowFilter(current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  const visibleRuns = useMemo(() => {
    const search = query.trim().toLowerCase()

    return runs.filter(job => {
      if (workflowFilter !== 'all' && getWorkflowSlug(job.workflowPath) !== workflowFilter) return false

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
  }, [runs, query, statusFilter, workflowFilter])

  const activeCount = runs.filter(job => !isTerminalStatus(job.status)).length
  const waitingCount = runs.filter(job => isWaitingStatus(job.status)).length

  return (
    <div className="space-y-6">
      <PageHeader
        title={PAGE_TITLES.runsList}
        description={PAGE_TITLES.runsListDescription}
        actions={
          <Button asChild>
            <Link to="/jobs/new">
              {PAGE_TITLES.newRun}
              <ArrowRight />
            </Link>
          </Button>
        }
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
                placeholder={`Search ${RUN_NOUN.pluralLower}`}
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
              <ErrorState title={`Could not load ${RUN_NOUN.pluralLower}`} message={error} />
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
                title={`No ${RUN_NOUN.pluralLower} match the current view`}
                description={`Create a ${RUN_NOUN.singularLower} or widen the filters to bring more work into view.`}
                action={
                  <Button asChild>
                    <Link to="/jobs/new">{`Create ${RUN_NOUN.singularLower}`}</Link>
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
      <table className="w-full min-w-[920px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-[10px] uppercase tracking-[0.16em] text-fg-subtle">
            <th className="px-4 py-3 font-medium">{RUN_NOUN.singular}</th>
            <th className="px-4 py-3 font-medium">Workflow</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Working on</th>
            <th className="px-4 py-3 font-medium">Updated</th>
            <th className="px-4 py-3 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {runs.map(job => {
            const workflowTag = getRunWorkflowTag(job)
            const carriesSubRuns = isCampaignJob(job)
            return (
              <tr key={job.id} className="group transition-colors hover:bg-overlay/40">
                <td className="px-4 py-3">
                  <Link to={getRunDetailPath(job)} className="block min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-fg group-hover:text-accent-300">
                        {deriveJobTitle(job)}
                      </span>
                      {carriesSubRuns ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-md border border-line bg-overlay px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-fg-muted"
                          title={`Hosts ${SUB_RUN_NOUN.pluralLower}`}
                        >
                          <Layers3 className="size-2.5" />
                          {SUB_RUN_NOUN.plural.toLowerCase()}
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate text-[12px] text-fg-subtle">
                      {[getRepoSlug(job)].filter(Boolean).join(' · ') || job.id}
                    </div>
                  </Link>
                </td>
                <td className="px-4 py-3 align-top">
                  <span className="inline-flex items-center rounded-md border border-line bg-overlay px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.12em] text-fg-muted">
                    {workflowTag}
                  </span>
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
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
