import {
  ExternalLink,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import LayerBadge from '../intelligence/layer-badge'
import PhaseTimeline, { PhaseBadge } from './phase-timeline'
import type { WorkflowOption } from '../../workflows'

// ── Workflow details popup ──────────────────────────────────────────────────
//
// Renders the supplied workflow (sourced from `GET /workflows`) as a vertical
// timeline of phases. Each phase shows its name, the agent file that runs it,
// the model bucket, any subagents it spawns, and a marker when the runner
// pauses for an interactive checkpoint. Designed to fit inside a Dialog so
// the user can review what they're about to launch without leaving the form.

interface WorkflowDetailsDialogProps {
  workflow: WorkflowOption | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function WorkflowDetailsDialog({
  workflow,
  open,
  onOpenChange,
}: WorkflowDetailsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-w-2xl flex-col gap-0 max-h-[min(720px,calc(100vh-2rem))]">
        <DialogHeader className="shrink-0">
          <div className="flex items-start gap-3">
            <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-500/15 ring-1 ring-accent-500/30 text-accent-200">
              <WorkflowIcon className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle>{workflow?.name ?? 'Workflow'}</DialogTitle>
                {workflow?.layer ? (
                  <LayerBadge layer={workflow.layer} overrides={workflow.overrides} />
                ) : null}
              </div>
              {workflow ? (
                <DialogDescription className="font-mono text-[11px] text-fg-subtle">
                  {workflow.workflowPath}
                </DialogDescription>
              ) : null}
            </div>
          </div>
        </DialogHeader>
        <DialogBody className="flex-1 min-h-0 space-y-5">
          {workflow?.description ? (
            <p className="text-sm leading-relaxed text-fg-muted">{workflow.description}</p>
          ) : null}

          {workflow && workflow.phases && workflow.phases.length > 0 ? (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                  Phases
                </h3>
                <span className="text-[11px] text-fg-subtle">
                  {workflow.phases.length} phase{workflow.phases.length === 1 ? '' : 's'}
                </span>
              </div>
              <PhaseTimeline workflow={workflow} />
            </div>
          ) : (
            <div className="rounded-xl border border-line bg-overlay/30 p-4 text-sm text-fg-muted">
              No phase information available for this workflow.
            </div>
          )}

          {workflow ? (
            <div className="flex items-center justify-between gap-3 border-t border-line pt-4 text-xs text-fg-subtle">
              <div className="flex items-center gap-2">
                <span>From</span>
                {workflow.layer ? (
                  <LayerBadge layer={workflow.layer} overrides={workflow.overrides} size="sm" />
                ) : (
                  <span className="font-mono">{shortenSource(workflow.source)}</span>
                )}
                {workflow.layer && workflow.source ? (
                  <span className="font-mono text-[10px] opacity-60" title={workflow.source}>
                    {shortenSource(workflow.source)}
                  </span>
                ) : null}
              </div>
              {workflow.kind !== 'job' ? (
                <PhaseBadge tone="muted">
                  <ExternalLink className="size-2.5" />
                  {workflow.kind}
                </PhaseBadge>
              ) : null}
            </div>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

function shortenSource(source: string | undefined): string {
  if (!source) return 'unknown'
  // Compress noisy absolute paths (e.g. node_modules nested layer dirs)
  // down to the last two segments — enough to identify which layer the
  // workflow came from without overwhelming the footer.
  const parts = source.split('/').filter(Boolean)
  if (parts.length <= 2) return source
  return '…/' + parts.slice(-2).join('/')
}
