import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  CheckCircle2,
  ChevronDown,
  Hand,
  Loader2,
  PauseCircle,
  TriangleAlert,
} from 'lucide-react'
import ArtifactChipRow from '../../jobs/artifact-chip-row'
import PhaseTrack from '../../jobs/phase-track'
import StatusBadge from '../../StatusBadge'
import { Button } from '../../ui/button'
import { useJob } from '../../../hooks/useJob'
import { useJobStream } from '../../../hooks/useJobStream'
import type { LogLineType } from '../../../hooks/useJobStream'
import { activityFallback, lastAgentActivity } from '../../../lib/job-activity'
import { deriveJobTitle } from '../../../lib/jobs'
import type { RunDraft } from '../../../lib/intake-run'
import { PAGE_TITLES } from '../../../lib/run-labels'
import {
  getJobDisplayStatus,
  getRunIndicator,
  isTerminalStatus,
  type RunIndicator,
} from '../../../lib/status'
import { deriveWorkflowPhases } from '../../../lib/workflow-phases'
import { usePlanSession } from '../../../providers/plan-session'
import { cn } from '../../../lib/utils'

/** Enough backlog to find the last meaningful line, small enough to be cheap. */
const ACTIVITY_TAIL = 50
/** Matches the job page's cadence so the two surfaces move together. */
const JOB_POLL_MS = 4_000

const SHELL = 'space-y-3 rounded-2xl border border-accent-500/25 bg-accent-500/[0.06] p-4'

function IndicatorGlyph({ indicator }: { indicator: RunIndicator }) {
  const { icon, label } = (() => {
    switch (indicator) {
      case 'running':
        return { icon: <Loader2 className="size-4 animate-spin text-accent-300" />, label: 'Running' }
      case 'paused':
        return { icon: <PauseCircle className="size-4 text-warning-400" />, label: 'Paused' }
      case 'waiting':
        return { icon: <Hand className="size-4 text-warning-400" />, label: 'Waiting' }
      case 'failed':
        return { icon: <TriangleAlert className="size-4 text-danger-400" />, label: 'Stopped' }
      case 'done':
      default:
        return { icon: <CheckCircle2 className="size-4 text-success-400" />, label: 'Done' }
    }
  })()

  return (
    <span className="flex size-6 shrink-0 items-center justify-center" title={label} aria-label={label}>
      {icon}
    </span>
  )
}

function activityDotClass(lineType: LogLineType): string {
  if (lineType === 'error' || lineType === 'guardrail') return 'bg-danger-400'
  if (lineType === 'warning') return 'bg-warning-400'
  if (lineType === 'result') return 'bg-success-400'
  if (lineType === 'human') return 'bg-accent-400'
  return 'bg-fg-subtle/70'
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-fg-subtle">{label}</dt>
      <dd className="min-w-0 break-words text-fg-muted">{value}</dd>
    </div>
  )
}

interface ActiveRunCardProps {
  run: RunDraft
  jobId: string
}

/**
 * The dispatched state of the chat's run card: a live summary of the job it
 * started. It owns its own data because the page it lives on has none — the
 * session's 30s job list is only a seed so the card paints instantly, and
 * both the poll and the log stream stop once the run is terminal, so an old
 * conversation costs nothing to re-open.
 */
export default function ActiveRunCard({ run, jobId }: ActiveRunCardProps) {
  const session = usePlanSession()
  const [detailsOpen, setDetailsOpen] = useState(false)

  const seed = session.jobs.find(candidate => candidate.id === jobId) ?? null
  const { job: fetched } = useJob(jobId, JOB_POLL_MS)
  const job = fetched ?? seed

  const live = job ? !isTerminalStatus(job.status) : false
  const { lines } = useJobStream(jobId, live, { tail: ACTIVITY_TAIL })

  const viewRun = (
    <Button asChild size="lg" className="w-full">
      <Link to={`/jobs/${jobId}`}>{PAGE_TITLES.viewRun}</Link>
    </Button>
  )

  // First paint before either source has answered, or a job the runner no
  // longer has. The link out still works, which is the one thing that must.
  if (!job) {
    return (
      <div className={SHELL}>
        <div className="flex items-center justify-between gap-3">
          <span className="truncate text-sm font-semibold text-fg">{run.serviceName}</span>
          <Loader2 className="size-4 shrink-0 animate-spin text-fg-subtle" />
        </div>
        <div className="text-[12px] text-fg-subtle">Loading run…</div>
        {viewRun}
      </div>
    )
  }

  const phases = deriveWorkflowPhases(job)
  const artifacts = [...(job.artifacts ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )
  const activity = lastAgentActivity(lines) ?? activityFallback(job)
  const workflowName =
    session.workflows.find(w => w.workflowPath === run.workflowPath)?.name ?? run.workflowPath

  return (
    <div className={SHELL}>
      {/* 1 — name + the same status label the Recents rail shows + live glyph */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold text-fg">{deriveJobTitle(job)}</span>
            <StatusBadge meta={getJobDisplayStatus(job)} />
          </div>
          <div className="mt-0.5 truncate text-[12px] text-fg-subtle">
            {job.phase}
            {job.currentWorkItem ? ` · ${job.currentWorkItem}` : ''}
          </div>
        </div>
        <IndicatorGlyph indicator={getRunIndicator(job)} />
      </div>

      {/* 2 — workflow steps, one row */}
      <PhaseTrack job={job} phases={phases} />

      {/* 3 — artefacts, one row */}
      <ArtifactChipRow jobId={job.id} artifacts={artifacts} />

      {/* 4 — the agent's last line */}
      <div className="flex items-center gap-2 rounded-lg border border-line/70 bg-canvas/40 px-2.5 py-1.5">
        <span
          className={cn('size-1.5 shrink-0 rounded-full', activityDotClass(activity.lineType))}
          aria-hidden
        />
        <span className="truncate font-mono text-[11.5px] text-fg-muted" title={activity.text}>
          {activity.text}
        </span>
      </div>

      {/* 5 — out to the run */}
      {viewRun}

      {/* the config that used to be this card's body, read-only */}
      <div className="border-t border-line/60 pt-2">
        <button
          type="button"
          aria-expanded={detailsOpen}
          onClick={() => setDetailsOpen(open => !open)}
          className="flex w-full items-center justify-between gap-2 text-left text-[11px] uppercase tracking-[0.14em] text-fg-subtle transition-colors hover:text-fg-muted"
        >
          Run details
          <ChevronDown className={cn('size-3.5 transition-transform', detailsOpen && 'rotate-180')} />
        </button>
        {detailsOpen ? (
          <dl className="mt-2 space-y-1 text-[12px]">
            <DetailRow label="Repository" value={run.repo} />
            <DetailRow label="Service" value={run.serviceName} />
            <DetailRow label="Workflow" value={workflowName} />
            {run.reviewers ? <DetailRow label="Reviewers" value={run.reviewers} /> : null}
            <DetailRow
              label="Mode"
              value={run.interactive ? 'Interactive — pauses at checkpoints' : 'Autonomous'}
            />
            <div className="whitespace-pre-wrap pt-1 text-fg-muted">{run.description}</div>
          </dl>
        ) : null}
      </div>
    </div>
  )
}
