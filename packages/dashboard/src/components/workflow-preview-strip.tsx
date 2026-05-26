import { ChevronRight } from 'lucide-react'
import type { WorkflowOption } from '../workflows'
import { cn } from '../lib/utils'

interface WorkflowPreviewStripProps {
  workflow: WorkflowOption | null
  interactive?: boolean
  className?: string
}

/** Horizontal phase pictogram for the New Run page — no job state required. */
export default function WorkflowPreviewStrip({
  workflow,
  interactive = false,
  className,
}: WorkflowPreviewStripProps) {
  const phases = workflow?.phases ?? []
  if (phases.length === 0) {
    return (
      <div className={cn('text-xs italic text-fg-subtle', className)}>
        Workflow phases will appear once loaded.
      </div>
    )
  }

  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <div className="flex min-w-max items-center gap-1 pb-1">
        {phases.map((phase, i) => (
          <div key={phase.name} className="flex items-center">
            <div
              className={cn(
                'rounded-lg border px-2.5 py-1.5 text-left',
                i === 0
                  ? 'border-accent-500/35 bg-accent-500/8'
                  : 'border-line bg-overlay/40',
              )}
            >
              <div className="truncate text-[12px] font-medium text-fg">{phase.name}</div>
              {phase.interactiveCheckpoint && interactive ? (
                <div className="mt-0.5 text-[9px] uppercase tracking-wider text-warning-300">
                  checkpoint
                </div>
              ) : null}
            </div>
            {i < phases.length - 1 ? (
              <ChevronRight className="mx-0.5 size-3.5 shrink-0 text-fg-subtle/60" aria-hidden />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}
