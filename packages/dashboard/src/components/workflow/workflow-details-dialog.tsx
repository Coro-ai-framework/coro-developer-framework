import {
  ArrowDown,
  Bot,
  CircleDot,
  ExternalLink,
  PauseCircle,
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
import { cn } from '../../lib/utils'
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
              <ol className="space-y-1.5">
                {workflow.phases.map((phase, idx) => {
                  const isInitial = phase.name === workflow.initialPhase
                  const isLast = idx === workflow.phases!.length - 1
                  return (
                    <li key={phase.name}>
                      <div
                        className={cn(
                          'rounded-xl border px-3 py-3 transition-colors',
                          isInitial
                            ? 'border-accent-500/40 bg-accent-500/5'
                            : 'border-line bg-overlay/30',
                        )}
                      >
                        <div className="flex items-start gap-3">
                          <span
                            className={cn(
                              'mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-mono ring-1',
                              isInitial
                                ? 'bg-accent-500/20 ring-accent-500/40 text-accent-200'
                                : 'bg-overlay/60 ring-line text-fg-muted',
                            )}
                          >
                            {idx + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="text-sm font-medium text-fg">{phase.name}</span>
                              {isInitial ? (
                                <Badge tone="accent">
                                  <CircleDot className="size-2.5" />
                                  Start
                                </Badge>
                              ) : null}
                              <Badge tone="model">{phase.model}</Badge>
                              {phase.interactiveCheckpoint ? (
                                <Badge tone="warning" title="Runner pauses for your approval before advancing">
                                  <PauseCircle className="size-2.5" />
                                  Checkpoint
                                </Badge>
                              ) : null}
                            </div>
                            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-fg-muted">
                              <Bot className="size-3 shrink-0" />
                              {phase.agent ? (
                                <span className="font-mono">{phase.agent}</span>
                              ) : (
                                <span className="italic">Runner-managed (no agent)</span>
                              )}
                            </div>
                            {phase.subagents.length > 0 ? (
                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-fg-subtle">
                                <span>Subagents:</span>
                                {phase.subagents.map(name => (
                                  <span
                                    key={name}
                                    className="rounded-md bg-overlay/60 px-1.5 py-0.5 font-mono ring-1 ring-line"
                                  >
                                    {name}
                                  </span>
                                ))}
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
                <Badge tone="muted">
                  <ExternalLink className="size-2.5" />
                  {workflow.kind}
                </Badge>
              ) : null}
            </div>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface BadgeProps {
  tone: 'accent' | 'warning' | 'muted' | 'model'
  children: React.ReactNode
  title?: string
}

function Badge({ tone, children, title }: BadgeProps) {
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

function shortenSource(source: string | undefined): string {
  if (!source) return 'unknown'
  // Compress noisy absolute paths (e.g. node_modules nested layer dirs)
  // down to the last two segments — enough to identify which layer the
  // workflow came from without overwhelming the footer.
  const parts = source.split('/').filter(Boolean)
  if (parts.length <= 2) return source
  return '…/' + parts.slice(-2).join('/')
}
