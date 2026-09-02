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
      <div className="mr-2 space-y-1.5">
        <button
          type="button"
          aria-expanded
          aria-label={`${frontLabel} — ${count} step${count === 1 ? '' : 's'}. Activate to collapse.`}
          onClick={toggle}
          className="font-mono text-[11.5px] leading-[1.6] text-fg-subtle hover:text-fg-muted"
        >
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
          className="font-mono text-[11.5px] text-fg-subtle hover:text-fg-muted"
        >
          Collapse
        </button>
      </div>
    )
  }

  return (
    <div className="relative mr-2 inline-block max-w-full">
      {depth >= 1 ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 translate-x-[3px] translate-y-[2px] rounded-full border border-line bg-overlay/30 opacity-60"
        />
      ) : null}
      {depth >= 2 ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-20 translate-x-[6px] translate-y-[4px] rounded-full border border-line bg-overlay/20 opacity-35"
        />
      ) : null}
      <button
        type="button"
        aria-expanded={false}
        aria-label={`${frontLabel} — ${count} step${count === 1 ? '' : 's'}. Activate to expand.`}
        onClick={toggle}
        className={cn(
          'relative inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-overlay/40 px-2.5 py-1 font-mono text-[11.5px] text-fg-subtle transition-colors hover:border-line-strong hover:text-fg-muted',
          failed && 'border-danger-500/30 text-danger-200',
        )}
      >
        {running ? (
          <Loader2 className="size-3 shrink-0 animate-spin" />
        ) : (
          <Icon className="size-3 shrink-0" />
        )}
        <span className="min-w-0 truncate">{frontLabel}</span>
        {count > 1 ? <span className="ml-0.5 tabular-nums text-fg-subtle/70">×{count}</span> : null}
      </button>
    </div>
  )
}
