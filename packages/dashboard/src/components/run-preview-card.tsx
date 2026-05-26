import { Ban, Clock, MessageSquare, Pause } from 'lucide-react'
import LayerBadge from './intelligence/layer-badge'
import PhaseTimeline from './workflow/phase-timeline'
import { Skeleton } from './ui/skeleton'
import { durationBandFor, type WorkflowOption } from '../workflows'
import { cn } from '../lib/utils'

export interface RunPreviewCardProps {
  workflow: WorkflowOption | null
  interactive: boolean
  mode: 'manual' | 'ticket'
  serviceName?: string
  repo?: string
  ticketId?: string
  formValid: boolean
  loading?: boolean
}

export default function RunPreviewCard({
  workflow,
  interactive,
  mode,
  serviceName,
  repo,
  ticketId,
  formValid,
  loading = false,
}: RunPreviewCardProps) {
  if (loading || !workflow) {
    return (
      <div className="space-y-3 rounded-2xl border border-line bg-overlay/30 p-5">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  const firstPhase = workflow.phases?.[0]?.name ?? 'the first phase'
  const phaseCount = workflow.phases?.length ?? 0

  const firstStop = interactive
    ? `Coro starts at ${firstPhase} and pauses at every checkpoint for your approval.`
    : 'Coro runs end-to-end and opens a PR. You can pause or message it mid-run.'

  const summary =
    mode === 'manual'
      ? serviceName?.trim() || repo?.trim() || 'Your run details'
      : ticketId?.trim() || 'Tracker ticket run'

  return (
    <div
      className={cn(
        'space-y-4 rounded-2xl border border-line bg-overlay/30 p-5 transition-opacity',
        !formValid && 'opacity-50',
      )}
    >
      <div>
        <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle">
          What will happen
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-fg">{workflow.name}</span>
          {workflow.layer ? (
            <LayerBadge layer={workflow.layer} overrides={workflow.overrides} size="sm" />
          ) : null}
          <span className="rounded-md border border-line bg-overlay/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-muted">
            {workflow.kind}
          </span>
        </div>
        {workflow.description ? (
          <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">{workflow.description}</p>
        ) : null}
        <p className="mt-1 text-xs font-medium text-fg">{summary}</p>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
          Phases
        </div>
        <PhaseTimeline workflow={workflow} compact />
      </div>

      <div className="rounded-xl border border-line bg-overlay/40 px-3 py-2.5 text-xs leading-relaxed text-fg-muted">
        {firstStop}
      </div>

      <div className="flex items-center gap-2 text-xs text-fg-muted">
        <Clock className="size-3.5 shrink-0 text-fg-subtle" />
        <span>{durationBandFor(workflow.workflowPath, phaseCount)}</span>
      </div>

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
          Mid-run controls
        </div>
        <div className="flex flex-wrap gap-2">
          <MidRunChip icon={Pause} label="Pause" />
          <MidRunChip icon={MessageSquare} label="Message" />
          <MidRunChip icon={Ban} label="Cancel" />
        </div>
      </div>

      <p className="text-[11px] text-fg-subtle">Token cost shows live on the run page.</p>
    </div>
  )
}

function MidRunChip({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-overlay/50 px-2.5 py-1 text-[11px] font-medium text-fg-muted">
      <Icon className="size-3 text-fg-subtle" />
      {label}
    </span>
  )
}
