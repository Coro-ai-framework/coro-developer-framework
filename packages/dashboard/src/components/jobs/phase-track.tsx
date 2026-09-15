import { useEffect, useRef } from 'react'
import { Check, Hourglass } from 'lucide-react'
import type { Job, WorkflowPhase } from '../../types'
import { computePhaseState, type PhaseState } from '../WorkflowFlow'
import { cn } from '../../lib/utils'

interface PhaseTrackProps {
  job: Job
  phases: WorkflowPhase[]
  className?: string
}

const CHIP_BASE =
  'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium'

function chipClasses(state: PhaseState): string {
  switch (state) {
    case 'complete':
      return cn(CHIP_BASE, 'border-success-500/25 bg-success-500/8 text-fg')
    case 'in-progress':
      return cn(CHIP_BASE, 'border-accent-500/40 bg-accent-500/12 text-fg')
    case 'awaiting-input':
      return cn(CHIP_BASE, 'border-warning-500/35 bg-warning-500/10 text-fg animate-pulse-slow')
    case 'pending':
    default:
      return cn(CHIP_BASE, 'border-line bg-overlay/40 text-fg-muted')
  }
}

function PhaseIcon({ state }: { state: PhaseState }) {
  if (state === 'complete') return <Check className="size-3 text-success-400" strokeWidth={2.5} />
  if (state === 'in-progress') {
    return <span className="size-1.5 rounded-full bg-accent-400 animate-pulse-dot" aria-hidden />
  }
  if (state === 'awaiting-input') return <Hourglass className="size-3 text-warning-400" />
  return <span className="size-1.5 rounded-full bg-fg-subtle/60" aria-hidden />
}

/**
 * One-row phase strip for compact surfaces. Phase state comes from
 * `computePhaseState` — the same function the job page's `WorkflowFlow`
 * uses — so the two views can never disagree about where a run is.
 */
export default function PhaseTrack({ job, phases, className }: PhaseTrackProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLSpanElement>(null)

  // Centre the live phase. Deliberately not `scrollIntoView`, which would
  // also scroll the chat feed (and the page) that hosts this strip.
  useEffect(() => {
    const container = scrollRef.current
    const node = activeRef.current
    if (!container || !node) return
    const target = node.offsetLeft - container.clientWidth / 2 + node.clientWidth / 2
    container.scrollTo({ left: Math.max(0, target), behavior: 'smooth' })
  }, [job.phase, job.status])

  if (phases.length === 0) return null

  return (
    <div
      ref={scrollRef}
      className={cn(
        'flex items-center gap-1 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {phases.map((phase, i) => {
        const state = computePhaseState(phase.name, phases, job)
        const active = state === 'in-progress' || state === 'awaiting-input'
        return (
          <span key={phase.name} className="flex shrink-0 items-center gap-1">
            <span
              ref={active ? activeRef : undefined}
              className={chipClasses(state)}
              title={`${phase.name} — ${state}`}
            >
              <PhaseIcon state={state} />
              {phase.name}
            </span>
            {i < phases.length - 1 ? (
              <span className="h-px w-2 shrink-0 bg-line" aria-hidden />
            ) : null}
          </span>
        )
      })}
    </div>
  )
}
