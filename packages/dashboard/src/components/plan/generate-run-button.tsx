import { cn } from '../../lib/utils'
import type { ActivityItem } from '../activity/types'
import type { Readiness } from '../../lib/intake-readiness'
import { PAGE_TITLES } from '../../lib/run-labels'

export function generateRunTitle(readiness: Readiness | null | undefined): string {
  const ready = readiness?.state === 'ready'
  const noRunNeeded = readiness?.state === 'no-run-needed'
  const openCount = readiness?.openQuestions.length ?? 0
  if (ready) return 'Coro has what it needs — generate the run.'
  if (noRunNeeded) {
    return 'Coro concluded no run is needed. Generate one anyway if you disagree.'
  }
  if (openCount > 0) {
    return `${openCount} question${openCount === 1 ? '' : 's'} still open — generate anyway and Coro will say what it assumed.`
  }
  return 'Generate the run from the conversation so far.'
}

/** A current (not superseded) run card means Generate run already did its job. */
export function conversationHasRun(items: ActivityItem[]): boolean {
  return items.some(item => {
    if (item.kind !== 'card' || item.card.type !== 'run') return false
    const state = (item.card.data as { state?: string }).state
    return state === 'draft' || state === 'dispatched'
  })
}

/**
 * Shared Generate run control. Compact sits in the composer footer; block
 * sits under a Findings write-up once readiness is `ready`. Once a run
 * card exists, this is a status label — not an action.
 */
export default function GenerateRunButton({
  layout = 'compact',
  readiness,
  disabled,
  generated = false,
  onClick,
}: {
  layout?: 'compact' | 'block'
  readiness: Readiness | null | undefined
  disabled?: boolean
  generated?: boolean
  onClick: () => void
}) {
  const ready = readiness?.state === 'ready'
  const openCount = readiness?.openQuestions.length ?? 0

  const sizing =
    layout === 'block'
      ? 'w-full rounded-full border px-4 py-2.5 text-sm'
      : 'rounded-full border px-2.5 py-1 text-[11px]'

  if (generated) {
    return (
      <span
        className={cn(
          'inline-flex items-center justify-center font-medium',
          sizing,
          'border-success-500/30 bg-success-500/10 text-success-400',
        )}
        title="A run already exists for this conversation."
      >
        {PAGE_TITLES.runGenerated}
      </span>
    )
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={generateRunTitle(readiness)}
      className={cn(
        'font-medium transition-colors disabled:opacity-50',
        sizing,
        ready
          ? 'animate-pulse-accent border-accent-500/50 bg-accent-500/10 text-accent-300 hover:border-accent-400 hover:bg-accent-500/15'
          : 'border-line-strong text-fg-subtle hover:border-line-strong hover:text-fg-muted',
      )}
    >
      {PAGE_TITLES.generateRun}
      {layout === 'compact' && !ready && openCount > 0 ? (
        <span className="ml-1 text-fg-subtle/70">· {openCount} open</span>
      ) : null}
    </button>
  )
}
