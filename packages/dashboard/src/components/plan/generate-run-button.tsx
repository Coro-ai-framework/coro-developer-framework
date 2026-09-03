import { cn } from '../../lib/utils'
import type { Readiness } from '../../lib/intake-readiness'

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

/**
 * Shared Generate run control. Compact sits in the composer footer; block
 * sits under a Findings write-up once readiness is `ready`.
 */
export default function GenerateRunButton({
  layout = 'compact',
  readiness,
  disabled,
  onClick,
}: {
  layout?: 'compact' | 'block'
  readiness: Readiness | null | undefined
  disabled?: boolean
  onClick: () => void
}) {
  const ready = readiness?.state === 'ready'
  const openCount = readiness?.openQuestions.length ?? 0

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={generateRunTitle(readiness)}
      className={cn(
        'font-medium transition-colors disabled:opacity-50',
        layout === 'block'
          ? 'w-full rounded-full border px-4 py-2.5 text-sm'
          : 'rounded-full border px-2.5 py-1 text-[11px]',
        ready
          ? 'animate-pulse-accent border-accent-500/50 bg-accent-500/10 text-accent-300 hover:border-accent-400 hover:bg-accent-500/15'
          : 'border-line-strong text-fg-subtle hover:border-line-strong hover:text-fg-muted',
      )}
    >
      Generate run
      {layout === 'compact' && !ready && openCount > 0 ? (
        <span className="ml-1 text-fg-subtle/70">· {openCount} open</span>
      ) : null}
    </button>
  )
}
