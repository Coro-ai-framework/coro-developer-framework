import { Badge } from '../ui/badge'
import { cn } from '../../lib/utils'
import { toneClasses, toneDotClasses, type Tone } from '../../lib/status'
import {
  SEVERITY_ORDER,
  SEVERITY_TONE,
  reviewStatusMeta,
  type FindingSeverity,
  type PrReview,
} from '../../lib/reviews'

export function ToneBadge({ tone, label, pulse, className }: { tone: Tone; label: string; pulse?: boolean; className?: string }) {
  return (
    <Badge variant="neutral" className={cn(toneClasses(tone), className)}>
      <span className={cn('size-1.5 rounded-full', toneDotClasses(tone), pulse && 'animate-pulse-dot')} />
      {label}
    </Badge>
  )
}

export function ReviewStatusBadge({ review, className }: { review: PrReview; className?: string }) {
  const meta = reviewStatusMeta(review)
  return <ToneBadge tone={meta.tone} label={meta.label} pulse={meta.pulse} className={className} />
}

export function SeverityBadge({ severity, className }: { severity: FindingSeverity; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]',
        toneClasses(SEVERITY_TONE[severity]),
        className,
      )}
    >
      {severity}
    </span>
  )
}

/** Compact "2 blocker · 1 major" chips; renders a muted dash when there is nothing open. */
export function SeverityCounts({ counts, className }: { counts: Record<FindingSeverity, number>; className?: string }) {
  const present = SEVERITY_ORDER.filter(severity => counts[severity] > 0)
  if (present.length === 0) return <span className={cn('text-[12px] text-fg-subtle', className)}>None open</span>
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {present.map(severity => (
        <span
          key={severity}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
            toneClasses(SEVERITY_TONE[severity]),
          )}
          title={`${counts[severity]} open ${severity}`}
        >
          {counts[severity]}
          <span className="text-[10px] uppercase tracking-[0.1em] opacity-80">{severity}</span>
        </span>
      ))}
    </div>
  )
}
