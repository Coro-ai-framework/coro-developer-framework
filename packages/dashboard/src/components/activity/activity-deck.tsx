import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import ActivityEntryRow from './activity-entry-row'
import { GROUP_META } from './group'
import type { ActivityEntry, ActivityGroup } from './types'

interface ActivityDeckProps {
  group: ActivityGroup
  entries: ActivityEntry[]
}

function deckFrontLabel(group: ActivityGroup, entries: ActivityEntry[]): string {
  const running = [...entries].reverse().find(e => e.status === 'running')
  if (running) {
    const rest = running.runningLabel.slice(1)
    return `Coro is ${running.runningLabel.charAt(0).toLowerCase()}${rest}…`
  }
  const failed = entries.filter(e => e.status === 'failed').length
  const base =
    entries.length === 1
      ? (entries[0].settledLabel ?? entries[0].runningLabel)
      : GROUP_META[group].rollup(entries.length)
  return failed > 0 ? `${base} · ${failed} failed` : base
}

export default function ActivityDeck({ group, entries }: ActivityDeckProps) {
  const [expanded, setExpanded] = useState(false)
  const userToggled = useRef(false)
  const hasFailed = entries.some(e => e.status === 'failed')
  const running = entries.some(e => e.status === 'running')
  const failed = entries.some(e => e.status === 'failed')

  useEffect(() => {
    if (hasFailed && !userToggled.current) setExpanded(true)
  }, [hasFailed])

  const frontLabel = deckFrontLabel(group, entries)
  const depth = Math.min(entries.length - 1, 2)
  const Icon = GROUP_META[group].icon
  const count = entries.length

  function toggle() {
    userToggled.current = true
    setExpanded(v => !v)
  }

  if (expanded) {
    return (
      <div className="block w-fit max-w-full space-y-1.5 pr-2">
        <button
          type="button"
          aria-expanded
          aria-label={`${frontLabel} — ${count} step${count === 1 ? '' : 's'}. Activate to collapse.`}
          onClick={toggle}
          className="inline-flex max-w-full items-center gap-1.5 font-mono text-[10px] leading-[1.5] text-fg-subtle hover:text-fg-muted"
        >
          <Icon className="size-3 shrink-0" />
          ▾ {frontLabel}
        </button>
        <div className="space-y-1.5">
          {entries.map(entry => (
            <ActivityEntryRow key={entry.id} entry={entry} />
          ))}
        </div>
        <button
          type="button"
          onClick={toggle}
          className="font-mono text-[10px] text-fg-subtle hover:text-fg-muted"
        >
          Collapse
        </button>
      </div>
    )
  }

  return (
    <div className="relative block w-fit max-w-full pb-1.5 pr-2.5">
      {depth >= 1 ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 rounded-full border border-line bg-overlay/35 opacity-70 translate-x-[4px] translate-y-[3px]"
        />
      ) : null}
      {depth >= 2 ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 rounded-full border border-line bg-overlay/25 opacity-50 translate-x-[8px] translate-y-[6px]"
        />
      ) : null}
      <button
        type="button"
        aria-expanded={false}
        aria-busy={running}
        aria-label={`${frontLabel} — ${count} step${count === 1 ? '' : 's'}. Activate to expand.`}
        onClick={toggle}
        className={cn(
          'relative z-10 inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-overlay/40 px-2 py-0.5 font-mono text-[10px] leading-[1.4] text-fg-subtle transition-colors hover:border-line-strong hover:text-fg-muted',
          failed && 'border-danger-500/30 text-danger-200',
        )}
      >
        <Icon className="size-3 shrink-0" />
        {running ? <Loader2 className="size-2.5 shrink-0 animate-spin" aria-hidden /> : null}
        <span className="min-w-0 truncate">{frontLabel}</span>
        {count > 1 ? <span className="ml-0.5 tabular-nums text-fg-subtle/70">×{count}</span> : null}
      </button>
    </div>
  )
}
