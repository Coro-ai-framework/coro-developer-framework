import type React from 'react'
import { AlertTriangle, Check, ChevronRight, Hand, Hourglass, RotateCw } from 'lucide-react'
import type { Artifact, Job, PhaseUsage, WorkflowPhase, WorkItem } from '../types'
import { cn } from '../lib/utils'

export type PhaseState = 'complete' | 'in-progress' | 'awaiting-input' | 'pending'

interface WorkflowFlowProps {
  job: Job
  phases: WorkflowPhase[]
  selectedPhase: string | null
  onSelectPhase: (phase: string) => void
}

/** Matches phase names from the job/workflow payloads (exact, then case-insensitive). */
function phaseIndex(phases: WorkflowPhase[], phaseName: string): number {
  const exact = phases.findIndex(p => p.name === phaseName)
  if (exact !== -1) return exact
  const target = phaseName.toLowerCase()
  return phases.findIndex(p => p.name.toLowerCase() === target)
}

/**
 * Determine the visual state of a phase node given the live job state.
 * A phase is:
 *   - `complete` if it appears before the current phase or has a phaseUsage entry
 *   - `awaiting-input` if it matches job.phase and status = awaiting-developer-input
 *   - `in-progress` if it matches job.phase and the job is not parked/terminal
 *   - `pending` otherwise
 */
export function computePhaseState(
  phaseName: string,
  phases: WorkflowPhase[],
  job: Job,
): PhaseState {
  const currentIdx = phaseIndex(phases, job.phase)
  const thisIdx = phaseIndex(phases, phaseName)
  const hasUsage = (job.phaseUsage ?? []).some(p => p.phase === phaseName)

  if (thisIdx === -1) return 'pending'

  if (thisIdx === currentIdx) {
    if (job.status === 'awaiting-developer-input') return 'awaiting-input'
    if (job.status === 'complete') return 'complete'
    return 'in-progress'
  }

  if (currentIdx !== -1 && thisIdx < currentIdx) return 'complete'
  if (hasUsage) return 'complete'
  if (job.status === 'complete') return 'complete'

  return 'pending'
}

function nodeClasses(state: PhaseState, selected: boolean): string {
  const base = 'relative flex-1 min-w-[150px] rounded-xl border px-3.5 py-2.5 text-left transition-colors cursor-pointer'
  const ring = selected ? 'ring-2 ring-accent-400/60 ring-offset-2 ring-offset-canvas' : ''
  switch (state) {
    case 'complete':
      return cn(base, ring, 'border-success-500/25 bg-success-500/8 hover:border-success-500/40')
    case 'in-progress':
      return cn(base, ring, 'border-accent-500/30 bg-accent-500/10 hover:border-accent-500/45')
    case 'awaiting-input':
      return cn(base, ring, 'border-warning-500/30 bg-warning-500/10 hover:border-warning-500/45 animate-pulse-slow')
    case 'pending':
    default:
      return cn(base, ring, 'border-line bg-overlay/40 hover:border-line-strong')
  }
}

function StateIcon({ state }: { state: PhaseState }): React.ReactElement {
  switch (state) {
    case 'complete':
      return <Check className="size-3.5 text-success-400" strokeWidth={2.5} />
    case 'in-progress':
      return <span className="size-1.5 rounded-full bg-accent-400 animate-pulse-dot" aria-hidden />
    case 'awaiting-input':
      return <Hourglass className="size-3.5 text-warning-400" />
    default:
      return <span className="size-1.5 rounded-full bg-fg-subtle/60" aria-hidden />
  }
}

function stateLabel(state: PhaseState): string {
  switch (state) {
    case 'complete':
      return 'Complete'
    case 'in-progress':
      return 'Running'
    case 'awaiting-input':
      return 'Awaiting input'
    case 'pending':
      return 'Pending'
  }
}

export default function WorkflowFlow({ job, phases, selectedPhase, onSelectPhase }: WorkflowFlowProps) {
  if (phases.length === 0) {
    return (
      <div className="px-2 py-3 text-sm italic text-fg-subtle">
        No workflow phases defined for this job.
      </div>
    )
  }

  const artifactsByPhase = new Map<string, Artifact[]>()
  for (const a of job.artifacts ?? []) {
    const bucket = artifactsByPhase.get(a.phase) ?? []
    bucket.push(a)
    artifactsByPhase.set(a.phase, bucket)
  }

  return (
    <div className="w-full overflow-x-auto">
      <div className="flex min-w-max items-stretch gap-2 pb-1">
        {phases.map((phase, i) => {
          const state = computePhaseState(phase.name, phases, job)
          const selected = selectedPhase === phase.name
          const artifacts = artifactsByPhase.get(phase.name) ?? []

          return (
            <div key={phase.name} className="flex items-stretch">
              <button
                type="button"
                onClick={() => onSelectPhase(phase.name)}
                className={nodeClasses(state, selected)}
              >
                <div className="flex items-center gap-2">
                  <span className="flex size-4 items-center justify-center">
                    <StateIcon state={state} />
                  </span>
                  <span className="truncate text-[13px] font-medium text-fg">{phase.name}</span>
                  {phase.interactiveCheckpoint && job.interactive ? (
                    <span
                      title="Interactive checkpoint — the job will park here for developer approval"
                      className="inline-flex items-center rounded-full border border-warning-500/25 bg-warning-500/10 px-1 py-0.5 text-warning-400"
                    >
                      <Hand className="size-3" />
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-[10px] uppercase tracking-[0.16em] text-fg-subtle">
                    {stateLabel(state)}
                  </span>
                  {artifacts.length > 0 ? (
                    <span className="rounded-full border border-line bg-overlay/60 px-1.5 py-0.5 text-[10px] text-fg-muted">
                      {artifacts.length}
                    </span>
                  ) : null}
                </div>
              </button>

              {i < phases.length - 1 ? (
                <div
                  className="flex shrink-0 items-center px-1 text-fg-subtle/60"
                  aria-hidden
                >
                  <ChevronRight className="size-4" />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Per-work-item breakdown ─────────────────────────────────────────────────
//
// Renders one row per work item that the planner registered (via
// `set_work_items`). Each row shows the looping phases attributed to
// that item — derived purely from `phaseUsage[]` entries whose
// `workItem` field matches the item name. The runner stamps that field
// when each phase completes, so this view reacts to repeats as they
// happen without any workflow-level loop metadata.
//
// Rows that have no `phaseUsage` activity yet are rendered as faint
// placeholders so the developer can still see the upcoming work, but
// without pretending to know exactly which phases will run (the loop
// shape is emergent, decided by the evaluator at runtime).

interface WorkItemsBreakdownProps {
  job: Job
  phases: WorkflowPhase[]
  onSelectPhase: (phase: string) => void
}

interface WorkItemRowData {
  item: WorkItem
  /** Phase executions stamped with this work item, in append order. */
  executions: PhaseUsage[]
  /** Distinct phase names this item has touched, in first-seen order. */
  distinctPhases: string[]
  /** True once the item has any phaseUsage entry attributed to it. */
  hasStarted: boolean
}

function buildWorkItemRows(job: Job): WorkItemRowData[] {
  const rows: WorkItemRowData[] = []
  for (const item of job.workItems ?? []) {
    const executions = (job.phaseUsage ?? []).filter(p => p.workItem === item.name)
    const distinctPhases: string[] = []
    for (const exec of executions) {
      if (!distinctPhases.includes(exec.phase)) distinctPhases.push(exec.phase)
    }
    rows.push({ item, executions, distinctPhases, hasStarted: executions.length > 0 })
  }
  return rows
}

function workItemStateLabel(item: WorkItem): string {
  if (item.status === 'complete') return 'Complete'
  if (item.status === 'in-progress') return 'In progress'
  if (item.status === 'escalated') return 'Escalated'
  return 'Pending'
}

function workItemDotClasses(item: WorkItem): string {
  switch (item.status) {
    case 'complete':
      return 'bg-success-400'
    case 'in-progress':
      return 'bg-accent-400 animate-pulse-dot'
    case 'escalated':
      return 'bg-danger-400'
    default:
      return 'bg-fg-subtle/60'
  }
}

function PhaseChip({
  phaseName,
  count,
  state,
  onClick,
}: {
  phaseName: string
  count: number
  state: 'complete' | 'in-progress' | 'pending'
  onClick: () => void
}) {
  const tone =
    state === 'in-progress'
      ? 'border-accent-500/35 bg-accent-500/10 text-fg hover:border-accent-500/55'
      : state === 'complete'
        ? 'border-success-500/25 bg-success-500/8 text-fg hover:border-success-500/40'
        : 'border-line bg-overlay/40 text-fg-muted hover:border-line-strong'
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors cursor-pointer',
        tone,
      )}
    >
      {state === 'complete' ? (
        <Check className="size-3 text-success-400" strokeWidth={2.5} />
      ) : state === 'in-progress' ? (
        <span className="size-1.5 rounded-full bg-accent-400 animate-pulse-dot" aria-hidden />
      ) : (
        <span className="size-1.5 rounded-full bg-fg-subtle/60" aria-hidden />
      )}
      <span>{phaseName}</span>
      {count > 1 ? (
        <span
          title={`Ran ${count} times for this work item`}
          className="inline-flex items-center gap-0.5 rounded-full bg-overlay/80 px-1 text-[10px] text-fg-muted"
        >
          <RotateCw className="size-2.5" />
          {count}
        </span>
      ) : null}
    </button>
  )
}

export function WorkItemsBreakdown({ job, phases, onSelectPhase }: WorkItemsBreakdownProps) {
  if (!job.workItems || job.workItems.length === 0) return null

  const rows = buildWorkItemRows(job)
  const knownPhaseNames = new Set(phases.map(p => p.name))

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
          Work items <span className="text-fg-muted">({job.workItems.length})</span>
        </div>
        {job.currentWorkItem ? (
          <div className="text-[11px] text-fg-subtle">
            current: <span className="text-fg">{job.currentWorkItem}</span>
          </div>
        ) : null}
      </div>
      <div className="space-y-1.5">
        {rows.map(row => {
          const { item, executions, distinctPhases, hasStarted } = row
          const isCurrent = job.currentWorkItem === item.name
          const phaseExecCounts = distinctPhases.map(name => ({
            name,
            count: executions.filter(e => e.phase === name).length,
          }))
          return (
            <div
              key={item.name}
              className={cn(
                'flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2',
                isCurrent
                  ? 'border-accent-500/30 bg-accent-500/8'
                  : hasStarted
                    ? 'border-line bg-overlay/40'
                    : 'border-line bg-overlay/20 opacity-70',
              )}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className={cn('size-2 rounded-full shrink-0', workItemDotClasses(item))} />
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-fg">{item.name}</div>
                  <div className="text-[10px] uppercase tracking-[0.14em] text-fg-subtle">
                    {workItemStateLabel(item)}
                    {item.loopCount > 0 ? (
                      <span className="ml-2 normal-case tracking-normal text-fg-muted">
                        · {item.loopCount} retr{item.loopCount === 1 ? 'y' : 'ies'}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>

              {hasStarted ? (
                <div className="flex flex-1 flex-wrap items-center gap-1.5">
                  {phaseExecCounts.map(({ name, count }) => {
                    const isActivePhase = isCurrent && job.phase === name
                    const isKnown = knownPhaseNames.has(name)
                    const state: 'complete' | 'in-progress' | 'pending' = isActivePhase
                      ? 'in-progress'
                      : 'complete'
                    return (
                      <PhaseChip
                        key={`${item.name}:${name}`}
                        phaseName={isKnown ? name : `${name} (ad-hoc)`}
                        count={count}
                        state={state}
                        onClick={() => onSelectPhase(name)}
                      />
                    )
                  })}
                  {isCurrent && job.phase && !distinctPhases.includes(job.phase) ? (
                    <PhaseChip
                      phaseName={job.phase}
                      count={1}
                      state="in-progress"
                      onClick={() => onSelectPhase(job.phase)}
                    />
                  ) : null}
                </div>
              ) : (
                <div className="text-[11px] italic text-fg-subtle">
                  {isCurrent ? 'starting…' : 'waiting'}
                </div>
              )}

              {item.status === 'escalated' ? (
                <span
                  title="This work item escalated and is waiting on a human"
                  className="inline-flex items-center gap-1 rounded-full border border-danger-500/30 bg-danger-500/10 px-2 py-0.5 text-[10px] text-danger-400"
                >
                  <AlertTriangle className="size-3" />
                  escalated
                </span>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
