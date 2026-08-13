import { Microscope } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import ErrorState from '../common/error-state'
import FindingsList from './findings-list'
import { enabledTierLabels } from '../../lib/retrospective'
import type { RetrospectiveSummary } from '../../types'

interface RetrospectiveFindingsPanelProps {
  retrospective: RetrospectiveSummary | null
  error?: string | null
  /**
   * Ids the developer has approved. Present only while the run waits at the
   * approval checkpoint — that is what turns the list into a ballot.
   */
  approved?: ReadonlySet<string>
  onToggleApproved?: (findingId: string) => void
  selectionDisabled?: boolean
}

/**
 * What the analyst found, shown on the run page so the developer reads the
 * findings in the same place they decide on them.
 *
 * At the approval checkpoint each finding carries a toggle. The toggles do
 * not send anything on their own: they build the decision that the approve
 * button below this panel transmits, so there is one approval action on the
 * page rather than two competing ones. Skipping is a first-class outcome —
 * an unapproved finding is recorded as not shipped, not silently dropped.
 *
 * Findings come from `GET /retrospectives/:jobId` rather than from the job's
 * artefacts directly: the runner is the only component that interprets the
 * report payload.
 */
export default function RetrospectiveFindingsPanel({
  retrospective,
  error,
  approved,
  onToggleApproved,
  selectionDisabled = false,
}: RetrospectiveFindingsPanelProps) {
  if (error) {
    return <ErrorState title="Could not load retrospective findings" message={error} />
  }
  if (!retrospective) return null

  const { findings, outcomes, jobWindow, tiers, awaitingApproval } = retrospective
  const tierLabels = enabledTierLabels(tiers)
  const selecting = approved !== undefined && onToggleApproved !== undefined
  const approvedCount = approved ? findings.filter(f => approved.has(f.id)).length : 0

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
            : selecting
              ? `Turn off anything you don\u2019t want acted on, then approve below. Approved findings may go to: ${tierLabels.join(', ') || 'nowhere — no destination was enabled'}.`
              : 'What the analyst found in this install\u2019s run history, and where each finding went.'}
        </CardDescription>
      </CardHeader>

      {findings.length > 0 ? (
        <CardContent className="space-y-3 pt-5">
          <FindingsList
            findings={findings}
            outcomes={outcomes}
            defaultExpandFirst={awaitingApproval}
            approved={approved}
            onToggleApproved={onToggleApproved}
            selectionDisabled={selectionDisabled}
          />
          {selecting ? <SelectionSummary approved={approvedCount} total={findings.length} /> : null}
        </CardContent>
      ) : null}
    </Card>
  )
}

function SelectionSummary({ approved, total }: { approved: number; total: number }) {
  const skipped = total - approved
  return (
    <p className="rounded-xl border border-line bg-overlay/40 px-3 py-2 text-xs leading-6 text-fg-muted">
      {approved === 0
        ? 'Nothing is selected. Approving will ship nothing and record all findings as not shipped.'
        : `Approving ships ${approved} of ${total} findings${skipped > 0 ? `; the other ${skipped} will be recorded as not shipped` : ''}.`}
    </p>
  )
}
