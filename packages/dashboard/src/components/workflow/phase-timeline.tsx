import {
  ArrowDown,
  Bot,
  CircleDot,
  PauseCircle,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import type { WorkflowOption } from '../../workflows'

interface PhaseBadgeProps {
  tone: 'accent' | 'warning' | 'muted' | 'model'
  children: React.ReactNode
  title?: string
}

export function PhaseBadge({ tone, children, title }: PhaseBadgeProps) {
  const toneClass = {
    accent: 'bg-accent-500/15 text-accent-200 ring-accent-500/30',
    warning: 'bg-warning-500/12 text-warning-200 ring-warning-500/30',
    muted: 'bg-overlay/60 text-fg-muted ring-line',
    model: 'bg-overlay/60 text-fg-muted ring-line',
  }[tone]
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1',
        toneClass,
      )}
    >
      {children}
    </span>
  )
}

interface PhaseTimelineProps {
  workflow: WorkflowOption
  /** Compact mode for the run preview card sidebar. */
  compact?: boolean
}

/** Vertical phase list shared by WorkflowDetailsDialog and RunPreviewCard. */
export default function PhaseTimeline({ workflow, compact = false }: PhaseTimelineProps) {
  const phases = workflow.phases ?? []
  if (phases.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-overlay/30 p-3 text-xs text-fg-muted">
        No phase information available.
      </div>
    )
  }

  return (
    <ol className={cn('space-y-1.5', compact && 'space-y-1')}>
      {phases.map((phase, idx) => {
        const isInitial = phase.name === workflow.initialPhase
        const isLast = idx === phases.length - 1
        return (
          <li key={phase.name}>
            <div
              className={cn(
                'rounded-xl border px-3 transition-colors',
                compact ? 'py-2' : 'py-3',
                isInitial
                  ? 'border-accent-500/40 bg-accent-500/5'
                  : 'border-line bg-overlay/30',
              )}
            >
              <div className="flex items-start gap-2.5">
                <span
                  className={cn(
                    'mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-mono ring-1',
                    isInitial
                      ? 'bg-accent-500/20 ring-accent-500/40 text-accent-200'
                      : 'bg-overlay/60 ring-line text-fg-muted',
                  )}
                >
                  {idx + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    <span className={cn('font-medium text-fg', compact ? 'text-xs' : 'text-sm')}>
                      {phase.name}
                    </span>
                    {isInitial ? (
                      <PhaseBadge tone="accent">
                        <CircleDot className="size-2.5" />
                        Start
                      </PhaseBadge>
                    ) : null}
                    <PhaseBadge tone="model">{phase.model}</PhaseBadge>
                    {phase.interactiveCheckpoint ? (
                      <PhaseBadge
                        tone="warning"
                        title="Runner pauses for your approval before advancing when interactive mode is on"
                      >
                        <PauseCircle className="size-2.5" />
                        Checkpoint
                      </PhaseBadge>
                    ) : null}
                  </div>
                  {!compact ? (
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-fg-muted">
                      <Bot className="size-3 shrink-0" />
                      {phase.agent ? (
                        <span className="font-mono">{phase.agent}</span>
                      ) : (
                        <span className="italic">Runner-managed</span>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
            {!isLast ? (
              <div className="flex justify-center py-0.5">
                <ArrowDown className="size-3 text-fg-subtle" />
              </div>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}
