import { useState } from 'react'
import { ChevronDown, ChevronRight, ExternalLink, GitPullRequest } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge } from '../ui/badge'
import { Switch } from '../ui/switch'
import { cn } from '../../lib/utils'
import {
  categoryDescription,
  categoryLabel,
  categoryTone,
  destinationLabel,
  destinationTone,
  outcomesByFinding,
  severityTone,
} from '../../lib/retrospective'
import type { RetrospectiveFinding, RetrospectiveOutcome } from '../../types'

interface FindingsListProps {
  findings: ReadonlyArray<RetrospectiveFinding>
  /** Where each finding ended up, once the shipping phase has run. */
  outcomes?: ReadonlyArray<RetrospectiveOutcome>
  /** Expand the first finding on mount. Used at the approval checkpoint. */
  defaultExpandFirst?: boolean
  /**
   * Ids the developer has approved. Presence of this prop is what turns the
   * cards into a ballot; `undefined` keeps the read-only rendering used by
   * the history page and by finished runs.
   */
  approved?: ReadonlySet<string>
  onToggleApproved?: (findingId: string) => void
  selectionDisabled?: boolean
  className?: string
}

/**
 * The one way a retrospective finding is rendered. Shared by the standalone
 * retrospective page and the approval checkpoint on job detail, so a finding
 * reads the same wherever the developer meets it.
 */
export default function FindingsList({
  findings,
  outcomes = [],
  defaultExpandFirst = false,
  approved,
  onToggleApproved,
  selectionDisabled = false,
  className,
}: FindingsListProps) {
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(defaultExpandFirst && findings[0] ? [findings[0].id] : []),
  )
  const outcomeFor = outcomesByFinding(outcomes)

  const toggle = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className={cn('space-y-2', className)}>
      {findings.map(finding => (
        <FindingCard
          key={finding.id}
          finding={finding}
          outcome={outcomeFor.get(finding.id)}
          expanded={expanded.has(finding.id)}
          onToggle={() => toggle(finding.id)}
          approved={approved ? approved.has(finding.id) : undefined}
          onToggleApproved={onToggleApproved ? () => onToggleApproved(finding.id) : undefined}
          selectionDisabled={selectionDisabled}
        />
      ))}
    </div>
  )
}

interface FindingCardProps {
  finding: RetrospectiveFinding
  outcome: RetrospectiveOutcome | undefined
  expanded: boolean
  onToggle: () => void
  /** `undefined` renders the card read-only. */
  approved?: boolean
  onToggleApproved?: () => void
  selectionDisabled?: boolean
}

function FindingCard({
  finding,
  outcome,
  expanded,
  onToggle,
  approved,
  onToggleApproved,
  selectionDisabled = false,
}: FindingCardProps) {
  const ChevronIcon = expanded ? ChevronDown : ChevronRight
  const selectable = approved !== undefined && onToggleApproved !== undefined

  return (
    <div
      className={cn(
        'rounded-xl border bg-overlay/40 transition-colors',
        selectable && !approved ? 'border-line/60 opacity-60' : 'border-line',
      )}
    >
      <div className="flex items-start">
        {selectable ? (
          <div className="flex items-center gap-2 py-3 pl-3 pt-4">
            <Switch
              checked={approved}
              onCheckedChange={onToggleApproved}
              disabled={selectionDisabled}
              size="sm"
              ariaLabel={approved ? `Skip finding ${finding.id}` : `Approve finding ${finding.id}`}
            />
          </div>
        ) : null}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-start gap-3 p-3 text-left"
        >
          <ChevronIcon className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              {/* The id is what an approval names, so it has to be readable
                  for a developer replying by message rather than by toggle. */}
              <span className="font-mono text-[11px] text-fg-subtle">{finding.id}</span>
              <Badge variant={severityTone(finding.severity)} className="capitalize">
                {finding.severity}
              </Badge>
              <Badge variant={categoryTone(finding.category)} title={categoryDescription(finding.category)}>
                {categoryLabel(finding.category)}
              </Badge>
              <span className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
                {finding.evidence.length} {finding.evidence.length === 1 ? 'run' : 'runs'}
              </span>
              {outcome ? (
                <Badge variant={destinationTone(outcome.destination)}>
                  {destinationLabel(outcome.destination)}
                </Badge>
              ) : null}
              {selectable && !approved ? (
                <span className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle">Will be skipped</span>
              ) : null}
            </div>
            <div className="text-sm font-medium leading-snug text-fg">{finding.title}</div>
          </div>
        </button>
      </div>

      {expanded ? (
        <div className="space-y-4 border-t border-line/60 px-4 py-4 pl-10">
          {finding.proposedRemedy ? (
            <Section title="Proposed fix">
              <p className="whitespace-pre-wrap text-sm leading-6 text-fg">{finding.proposedRemedy}</p>
            </Section>
          ) : null}

          {finding.targetPaths?.length ? (
            <Section title="Files it would touch">
              <ul className="space-y-1">
                {finding.targetPaths.map(path => (
                  <li key={path} className="font-mono text-xs text-fg-muted">
                    {path}
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          <Section title="Evidence">
            {finding.evidence.length === 0 ? (
              <p className="text-sm text-fg-subtle">
                No runs were cited. A finding without evidence should be sent back.
              </p>
            ) : (
              <ul className="space-y-2">
                {finding.evidence.map(item => (
                  <li key={`${item.jobId}:${item.detail}`} className="space-y-1">
                    <Link
                      to={`/jobs/${item.jobId}`}
                      className="font-mono text-xs text-accent-300 hover:underline"
                    >
                      {item.jobId}
                    </Link>
                    {item.detail ? <p className="text-sm leading-6 text-fg-muted">{item.detail}</p> : null}
                    {item.metrics ? <MetricsRow metrics={item.metrics} /> : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {outcome ? <OutcomeSection outcome={outcome} /> : null}
        </div>
      ) : null}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle">{title}</div>
      {children}
    </div>
  )
}

function MetricsRow({ metrics }: { metrics: Record<string, unknown> }) {
  const entries = Object.entries(metrics).filter(([, value]) => value !== null && value !== undefined)
  if (entries.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([key, value]) => (
        <span
          key={key}
          className="rounded-md border border-line bg-overlay px-1.5 py-0.5 font-mono text-[11px] text-fg-muted"
        >
          {key}: {typeof value === 'object' ? JSON.stringify(value) : String(value)}
        </span>
      ))}
    </div>
  )
}

function OutcomeSection({ outcome }: { outcome: RetrospectiveOutcome }) {
  return (
    <Section title="Where it went">
      <div className="space-y-1.5">
        {outcome.reason ? <p className="text-sm leading-6 text-fg-muted">{outcome.reason}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          {outcome.prUrl ? <OutcomeLink href={outcome.prUrl} label="Pull request" pr /> : null}
          {outcome.issueUrl ? <OutcomeLink href={outcome.issueUrl} label="Issue" /> : null}
          {outcome.childJobId ? (
            <Link
              to={`/jobs/${outcome.childJobId}`}
              className="inline-flex items-center gap-1.5 text-sm text-accent-300 hover:underline"
            >
              Implementation run
            </Link>
          ) : null}
        </div>
      </div>
    </Section>
  )
}

function OutcomeLink({ href, label, pr = false }: { href: string; label: string; pr?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-sm text-accent-300 hover:underline"
    >
      {pr ? <GitPullRequest className="size-3.5" /> : <ExternalLink className="size-3.5" />}
      {label}
    </a>
  )
}
