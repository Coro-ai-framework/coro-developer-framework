import { useState, type ReactNode } from 'react'
import { ChevronDown, type LucideIcon } from 'lucide-react'
import { cn } from '../../../lib/utils'

interface CardShellProps {
  icon?: LucideIcon
  title: string
  /** One-line summary shown while collapsed. */
  summary?: ReactNode
  /** Badges next to the title (e.g. Interactive, Superseded). */
  badges?: ReactNode
  /** Primary action, pinned bottom-right when collapsed and bottom-full when expanded. */
  action?: ReactNode
  /** Visually de-emphasise (superseded / historical). */
  dimmed?: boolean
  defaultExpanded?: boolean
  children?: ReactNode
}

export default function CardShell({
  icon: Icon,
  title,
  summary,
  badges,
  action,
  dimmed = false,
  defaultExpanded = false,
  children,
}: CardShellProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <div
      className={cn(
        'rounded-2xl border border-accent-500/25 bg-accent-500/[0.06] p-4 transition-colors',
        dimmed && 'border-line bg-overlay/20 opacity-60',
      )}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-start gap-3 text-left"
      >
        {Icon ? <Icon className="mt-0.5 size-4 shrink-0 text-accent-300" /> : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-fg">{title}</span>
            {badges}
          </div>
          {!expanded && summary ? (
            <div className="mt-1 text-[13px] leading-[1.6] text-fg-muted">{summary}</div>
          ) : null}
        </div>
        <ChevronDown
          className={cn('mt-0.5 size-4 shrink-0 text-fg-subtle transition-transform', expanded && 'rotate-180')}
        />
      </button>

      {expanded && children ? (
        <div className="mt-4 space-y-4 border-t border-line/60 pt-4">{children}</div>
      ) : null}

      {action ? (
        <div className={cn('mt-4', expanded ? 'w-full' : 'flex justify-end')}>{action}</div>
      ) : null}
    </div>
  )
}
