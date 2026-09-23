import type { Job, WorkflowPhase } from '../../types'
import { latestPhaseUsage } from '../../lib/job-detail-presentation'
import { formatDuration, formatPreciseCurrency } from '../../lib/format'
import { deriveWorkflowLabel } from '../../lib/jobs'
import WorkflowFlow, { computePhaseState, phaseStateLabel } from '../WorkflowFlow'
import { Badge } from '../ui/badge'
import { Card, CardContent, CardHeader } from '../ui/card'
import PhaseArtifactShelf from './PhaseArtifactShelf'
import PhaseModelPanel from './PhaseModelPanel'

interface RunNavigatorProps {
  job: Job
  selectedPhase: string | null
  phases: WorkflowPhase[]
  onSelectPhase: (phase: string) => void
  onMutated: () => void
}

export default function RunNavigator({
  job,
  selectedPhase,
  phases,
  onSelectPhase,
  onMutated,
}: RunNavigatorProps) {
  const selectedPhaseName = selectedPhase ?? job.phase
  const inspecting = selectedPhase != null && selectedPhase !== job.phase
  const phaseUsage = latestPhaseUsage(job.phaseUsage, selectedPhaseName)
  const phaseState = computePhaseState(selectedPhaseName, phases, job)

  return (
    <Card>
      <CardHeader className="gap-2 border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 truncate text-sm font-semibold text-fg">
            {deriveWorkflowLabel(job.workflowPath)}
          </div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
            <span>Spend</span>
            <Badge variant="neutral" className="border-line bg-overlay text-fg tabular-nums">
              {formatPreciseCurrency(job.tokenUsage?.totalCostUsd ?? 0)}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-4 py-3">
        <WorkflowFlow
          job={job}
          phases={phases}
          selectedPhase={selectedPhaseName}
          onSelectPhase={onSelectPhase}
          density="compact"
        />

        <div className="space-y-3 rounded-xl border border-line bg-overlay/30 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <div className="flex w-full items-start justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
                <span>{inspecting ? 'Inspecting phase' : 'Live phase'}</span>
                <span className="normal-case tracking-normal text-fg-muted">{phaseStateLabel(phaseState)}</span>
                {inspecting ? (
                  <button
                    type="button"
                    onClick={() => onSelectPhase(job.phase)}
                    className="normal-case tracking-normal text-accent-300 hover:text-accent-400"
                  >
                    Back to live phase
                  </button>
                ) : null}
              </div>
              {phaseUsage ? (
                <div className="flex shrink-0 flex-wrap justify-end gap-x-3 gap-y-1 text-[12px] text-fg-muted">
                  <span><span className="text-fg-subtle">turns</span> <span className="tabular-nums text-fg">{phaseUsage.numTurns}</span></span>
                  <span><span className="text-fg-subtle">duration</span> <span className="tabular-nums text-fg">{formatDuration(phaseUsage.durationMs)}</span></span>
                  <span><span className="text-fg-subtle">cost</span> <span className="tabular-nums text-fg">{formatPreciseCurrency(phaseUsage.costUsd)}</span></span>
                </div>
              ) : null}
            </div>

            <div className="truncate text-sm font-semibold text-fg">{selectedPhaseName}</div>
            <PhaseModelPanel
              job={job}
              phase={selectedPhaseName}
              onMutated={onMutated}
            />
          </div>

          <PhaseArtifactShelf jobId={job.id} artifacts={job.artifacts ?? []} />
        </div>
      </CardContent>
    </Card>
  )
}
