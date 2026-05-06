import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, CornerDownRight, History as HistoryIcon, Layers3, Search } from 'lucide-react'
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
import { deriveJobDescription, deriveJobTitle, getRunDetailPath, isCampaignJob, sortJobsByUpdatedAt } from '../lib/jobs'
import {
  PAGE_TITLES,
  RUN_NOUN,
  SUB_RUN_NOUN,
  deriveWorkflowFilterOptions,
  getParentRunId,
  getRunWorkflowTag,
  getWorkflowSlug,
} from '../lib/run-labels'
import { isTerminalStatus } from '../lib/status'
import { useJobs } from '../hooks/useJobs'
import type { Job } from '../types'

type OutcomeFilter = 'all' | 'cancelled' | 'complete' | 'failed' | 'escalated'

const OUTCOME_FILTERS = [
  { value: 'all' as const, label: 'All outcomes' },
  { value: 'cancelled' as const, label: 'Cancelled' },
  { value: 'complete' as const, label: 'Complete' },
  { value: 'failed' as const, label: 'Failed' },
  { value: 'escalated' as const, label: 'Escalated' },
]

interface HistoryRow {
  parent: Job
  subRuns: Job[]
}

export default function History() {
  const { jobs, loading, error } = useJobs()
  const [query, setQuery] = useState('')
  const [workflowFilter, setWorkflowFilter] = useState<string>('all')
  const [outcome, setOutcome] = useState<OutcomeFilter>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

  const terminalJobs = useMemo(
    () => sortJobsByUpdatedAt(jobs.filter(job => isTerminalStatus(job.status))),
    [jobs],
  )

  const workflowOptions = useMemo(() => deriveWorkflowFilterOptions(terminalJobs), [terminalJobs])

  const matchesFilter = useMemo(() => {
    const search = query.trim().toLowerCase()
    return (job: Job): boolean => {
      if (workflowFilter !== 'all' && getWorkflowSlug(job.workflowPath) !== workflowFilter) return false
      if (outcome !== 'all' && job.status !== outcome) return false
      if (!search) return true

      const haystack = [job.id, deriveJobTitle(job), deriveJobDescription(job), job.phase]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return haystack.includes(search)
    }
  }, [query, workflowFilter, outcome])

  const idSet = useMemo(() => new Set(terminalJobs.map(j => j.id)), [terminalJobs])

  const subRunsByParent = useMemo(() => {
    const map = new Map<string, Job[]>()
    for (const job of terminalJobs) {
      const parentId = getParentRunId(job)
      if (!parentId) continue
      const bucket = map.get(parentId) ?? []
      bucket.push(job)
      map.set(parentId, bucket)
    }
    return map
  }, [terminalJobs])

  const visibleRows = useMemo<HistoryRow[]>(() => {
    const rows: HistoryRow[] = []
    for (const job of terminalJobs) {
      const parentId = getParentRunId(job)
      const isTopLevel = !parentId || !idSet.has(parentId)
      if (!isTopLevel) continue

      const subRuns = subRunsByParent.get(job.id) ?? []
      const include = matchesFilter(job) || subRuns.some(matchesFilter)
      if (!include) continue

      rows.push({ parent: job, subRuns })
    }
    return rows
  }, [terminalJobs, idSet, subRunsByParent, matchesFilter])

  const visibleCount = useMemo(
    () => visibleRows.reduce((acc, row) => acc + 1 + row.subRuns.length, 0),
    [visibleRows],
  )

  const cancelledCount = terminalJobs.filter(job => job.status === 'cancelled').length
  const completedCount = terminalJobs.filter(job => job.status === 'complete').length
  const failedCount = terminalJobs.filter(job => job.status === 'failed').length
  const escalatedCount = terminalJobs.filter(job => job.status === 'escalated').length

  const toggleCollapsed = (parentId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(parentId)) next.delete(parentId)
      else next.add(parentId)
      return next
    })
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={PAGE_TITLES.history}
        description={`Completed, cancelled, failed, and escalated ${RUN_NOUN.pluralLower}. ${completedCount} done · ${cancelledCount} cancelled · ${failedCount} failed · ${escalatedCount} escalated.`}
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
            <SegmentedControl<OutcomeFilter>
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
              {visibleCount} / {terminalJobs.length}
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
          ) : visibleRows.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={HistoryIcon}
                title={`No archived ${RUN_NOUN.pluralLower} match the current filters`}
                description="Adjust the filters or wait for current work to finish."
              />
            </div>
          ) : (
            <HistoryTable rows={visibleRows} collapsed={collapsed} onToggle={toggleCollapsed} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

interface HistoryTableProps {
  rows: HistoryRow[]
  collapsed: Set<string>
  onToggle: (parentId: string) => void
}

function HistoryTable({ rows, collapsed, onToggle }: HistoryTableProps) {
  return (
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
          {rows.map(row => {
            const hasSubRuns = row.subRuns.length > 0
            const isCollapsed = hasSubRuns && collapsed.has(row.parent.id)
            const showChildren = hasSubRuns && !isCollapsed
            return (
              <HistoryFragmentRow
                key={row.parent.id}
                row={row}
                isCollapsed={isCollapsed}
                showChildren={showChildren}
                onToggle={onToggle}
              />
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

interface HistoryFragmentRowProps {
  row: HistoryRow
  isCollapsed: boolean
  showChildren: boolean
  onToggle: (parentId: string) => void
}

function HistoryFragmentRow({ row, isCollapsed, showChildren, onToggle }: HistoryFragmentRowProps) {
  const hasSubRuns = row.subRuns.length > 0
  return (
    <>
      <ParentHistoryRow
        job={row.parent}
        subRunCount={row.subRuns.length}
        isCollapsed={isCollapsed}
        onToggle={hasSubRuns ? () => onToggle(row.parent.id) : undefined}
      />
      {showChildren ? row.subRuns.map(child => <SubRunHistoryRow key={child.id} job={child} />) : null}
    </>
  )
}

interface ParentHistoryRowProps {
  job: Job
  subRunCount: number
  isCollapsed: boolean
  onToggle: (() => void) | undefined
}

function ParentHistoryRow({ job, subRunCount, isCollapsed, onToggle }: ParentHistoryRowProps) {
  const detailPath = getRunDetailPath(job)
  const carriesSubRuns = isCampaignJob(job) || subRunCount > 0
  const ChevronIcon = isCollapsed ? ChevronRight : ChevronDown

  return (
    <tr className="group transition-colors hover:bg-overlay/40">
      <td className="px-4 py-3">
        <div className="flex items-start gap-2">
          {onToggle ? (
            <button
              type="button"
              onClick={onToggle}
              className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-overlay hover:text-fg"
              aria-label={isCollapsed ? `Expand ${SUB_RUN_NOUN.pluralLower}` : `Collapse ${SUB_RUN_NOUN.pluralLower}`}
              aria-expanded={!isCollapsed}
            >
              <ChevronIcon className="size-3.5" />
            </button>
          ) : (
            <span className="mt-0.5 size-5 shrink-0" aria-hidden />
          )}
          <Link to={detailPath} className="block min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium text-fg group-hover:text-accent-300">
                {deriveJobTitle(job)}
              </span>
              {carriesSubRuns ? (
                <span
                  className="inline-flex items-center gap-1 rounded-md border border-line bg-overlay px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-fg-muted"
                  title={`Hosts ${SUB_RUN_NOUN.pluralLower}`}
                >
                  <Layers3 className="size-2.5" />
                  {subRunCount > 0
                    ? `${subRunCount} ${subRunCount === 1 ? SUB_RUN_NOUN.singularLower : SUB_RUN_NOUN.pluralLower}`
                    : SUB_RUN_NOUN.plural.toLowerCase()}
                </span>
              ) : null}
            </div>
            {deriveJobDescription(job) ? (
              <div className="line-clamp-1 text-[12px] text-fg-subtle">{deriveJobDescription(job)}</div>
            ) : null}
          </Link>
        </div>
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
}

function SubRunHistoryRow({ job }: { job: Job }) {
  const detailPath = getRunDetailPath(job)
  const subRunChildName = typeof job.params['campaignChildName'] === 'string' ? (job.params['campaignChildName'] as string) : null

  return (
    <tr className="group bg-overlay/20 transition-colors hover:bg-overlay/40">
      <td className="px-4 py-2.5">
        <div className="flex items-start gap-2 pl-7">
          <CornerDownRight className="mt-1 size-3.5 shrink-0 text-fg-subtle/70" aria-hidden />
          <Link to={detailPath} className="block min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-[13px] font-medium text-fg-muted group-hover:text-accent-300">
                {subRunChildName ?? deriveJobTitle(job)}
              </span>
              <span
                className="inline-flex items-center gap-0.5 rounded-md border border-line bg-overlay px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-fg-subtle"
                title={SUB_RUN_NOUN.singular}
              >
                {SUB_RUN_NOUN.singularLower}
              </span>
            </div>
            <div className="truncate text-[11px] text-fg-subtle">{job.id}</div>
          </Link>
        </div>
      </td>
      <td className="px-4 py-2.5 align-top">
        <span className="inline-flex items-center rounded-md border border-line bg-overlay px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.12em] text-fg-muted">
          {getRunWorkflowTag(job)}
        </span>
      </td>
      <td className="px-4 py-2.5 align-top">
        <StatusBadge status={job.status} />
      </td>
      <td className="px-4 py-2.5 align-top text-[13px] text-fg-muted">{job.phase}</td>
      <td className="whitespace-nowrap px-4 py-2.5 align-top text-[13px] text-fg-muted">
        {formatRelativeTime(job.updatedAt)}
      </td>
      <td className="whitespace-nowrap px-4 py-2.5 align-top text-right tabular-nums text-fg-muted">
        {formatPreciseCurrency(job.tokenUsage?.totalCostUsd ?? 0)}
      </td>
    </tr>
  )
}
