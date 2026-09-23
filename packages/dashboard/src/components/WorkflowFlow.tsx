import type React from 'react'
import { Check, ChevronRight, Hand, Hourglass, RotateCw } from 'lucide-react'
import type { Artifact, Job, WorkflowPhase } from '../types'
import { isWaitingStatus } from '../lib/status'
import { cn } from '../lib/utils'

export type PhaseState = 'complete' | 'in-progress' | 'awaiting-input' | 'pending'

interface WorkflowFlowProps {
  job: Job
  phases: WorkflowPhase[]
  selectedPhase: string | null
  onSelectPhase: (phase: string) => void
  /** Tighter phase nodes for the job-detail navigator. */
  density?: 'default' | 'compact'
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
    if (job.status === 'complete') return 'complete'
    if (isWaitingStatus(job.status)) return 'awaiting-input'
    return 'in-progress'
  }

  if (currentIdx !== -1 && thisIdx < currentIdx) return 'complete'
  if (hasUsage) return 'complete'
  if (job.status === 'complete') return 'complete'

  return 'pending'
}

function nodeClasses(state: PhaseState, selected: boolean, compact: boolean): string {
  const base = compact
    ? 'relative max-w-[11rem] shrink-0 min-w-[118px] rounded-lg border px-2.5 py-1.5 text-left transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60'
    : 'relative flex-1 min-w-[150px] rounded-xl border px-3.5 py-2.5 text-left transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60'
  const ring = selected ? 'ring-2 ring-accent-400/60 ring-offset-2 ring-offset-canvas' : ''
  switch (state) {
    case 'complete':
      return cn(base, ring, 'border-success-500/25 bg-success-500/8 hover:border-success-500/40')
    case 'in-progress':
      return cn(
        base,
        ring,
        'border-transparent bg-accent-500/10 hover:bg-accent-500/15 animate-border-travel',
      )
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

export function phaseStateLabel(state: PhaseState): string {
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

export default function WorkflowFlow({
  job,
  phases,
  selectedPhase,
  onSelectPhase,
  density = 'default',
}: WorkflowFlowProps) {
  const compact = density === 'compact'
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

  // Iteration counts per phase: how many times the runner actually
  // executed this phase across the whole job. Surfaces loop-backs
  // (e.g. coding ↔ evaluation) right in the top strip so the user can
  // see "this phase ran 3 times" without drilling in.
  const iterationsByPhase = new Map<string, number>()
  for (const usage of job.phaseUsage ?? []) {
    iterationsByPhase.set(usage.phase, (iterationsByPhase.get(usage.phase) ?? 0) + 1)
  }

  return (
    <div className="w-full overflow-x-auto py-1.5">
      <div className="flex min-w-max items-stretch gap-2">
        {phases.map((phase, i) => {
          const state = computePhaseState(phase.name, phases, job)
          const selected = selectedPhase === phase.name
          const artifacts = artifactsByPhase.get(phase.name) ?? []
          const iterations = iterationsByPhase.get(phase.name) ?? 0

          return (
            <div key={phase.name} className="flex items-stretch">
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelectPhase(phase.name)}
                className={nodeClasses(state, selected, compact)}
              >
                <div className={cn('flex items-center', compact ? 'gap-1.5' : 'gap-2')}>
                  <span className="flex size-4 items-center justify-center">
                    <StateIcon state={state} />
                  </span>
                  <span className={cn('min-w-0 truncate font-medium text-fg', compact ? 'text-[12px]' : 'text-[13px]')}>
                    {phase.name}
                  </span>
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
                    {phaseStateLabel(state)}
                  </span>
                  <span className="flex items-center gap-1.5">
                    {iterations > 1 ? (
                      <span
                        title={`Phase ran ${iterations} times (loop-back)`}
                        className="inline-flex items-center gap-0.5 rounded-full border border-accent-500/25 bg-accent-500/10 px-1.5 py-0.5 text-[10px] text-accent-300"
                      >
                        <RotateCw className="size-2.5" />
                        {iterations}×
                      </span>
                    ) : null}
                    {artifacts.length > 0 ? (
                      <span
                        title={`${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}`}
                        className="rounded-full border border-line bg-overlay/60 px-1.5 py-0.5 text-[10px] text-fg-muted"
                      >
                        {artifacts.length}
                      </span>
                    ) : null}
                  </span>
                </div>
              </button>

              {i < phases.length - 1 ? (
                <div
                  className="flex shrink-0 items-center px-1 text-fg-subtle/60"
                  aria-hidden
                >
                  <ChevronRight className={compact ? 'size-3.5' : 'size-4'} />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
