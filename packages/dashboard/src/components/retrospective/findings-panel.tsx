import { Microscope } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import ErrorState from '../common/error-state'
import FindingsList from './findings-list'
import { useRetrospective } from '../../hooks/useRetrospectives'
import { enabledTierLabels } from '../../lib/retrospective'
import type { Job } from '../../types'

interface RetrospectiveFindingsPanelProps {
  job: Job
}

/**
 * What the analyst found, shown on the run page so the developer reads the
 * findings in the same place they approve them — the `ApprovalBox` below this
 * panel owns the approve / send-back interaction.
 *
 * Findings come from `GET /retrospectives/:jobId` rather than from the job's
 * artefacts directly: the runner is the only component that interprets the
 * report payload.
 */
export default function RetrospectiveFindingsPanel({ job }: RetrospectiveFindingsPanelProps) {
  const { retrospective, error } = useRetrospective(job.id, job.updatedAt)

  if (error) {
    return <ErrorState title="Could not load retrospective findings" message={error} />
  }
  if (!retrospective) return null

  const { findings, outcomes, jobWindow, tiers, awaitingApproval } = retrospective
  const tierLabels = enabledTierLabels(tiers)

  return (
    <Card className={awaitingApproval ? 'border-warning-500/30' : undefined}>
      <CardHeader className="border-b border-line pb-4">
        <CardTitle className="flex items-center gap-2">
          <Microscope className="size-4 text-accent-300" aria-hidden />
          Findings
          <span className="text-sm font-normal text-fg-muted">
            ({findings.length} from {jobWindow} runs)
          </span>
        </CardTitle>
        <CardDescription>
          {findings.length === 0
            ? 'Nothing reported yet. The analyst posts its findings when the analysis phase finishes.'
            : awaitingApproval
              ? `Approve to let the analyst ship these, or send it back with changes. Approved findings may go to: ${tierLabels.join(', ') || 'nowhere — no destination was enabled'}.`
              : 'What the analyst found in this install\u2019s run history, and where each finding went.'}
        </CardDescription>
      </CardHeader>

      {findings.length > 0 ? (
        <CardContent className="pt-5">
          <FindingsList findings={findings} outcomes={outcomes} defaultExpandFirst={awaitingApproval} />
        </CardContent>
      ) : null}
    </Card>
  )
}
