import { useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { iconForActivity } from './group'
import type { ActivityEntry } from './types'

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms)}ms`
}

export default function ActivityEntryRow({ entry }: { entry: ActivityEntry }) {
  const [open, setOpen] = useState(false)
  const label = entry.settledLabel ?? entry.runningLabel
  const failed = entry.status === 'failed'
  const running = entry.status === 'running'
  const hasDetail = entry.detail !== undefined
  const Icon = iconForActivity(entry.group, entry.sourceName)

  return (
    <div className="font-mono text-[10px] leading-[1.5] text-fg-subtle">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-3 shrink-0" aria-hidden />
        {running ? <Loader2 className="mt-0.5 size-2.5 shrink-0 animate-spin" aria-hidden /> : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <span className={cn('min-w-0 flex-1 break-words', failed && 'text-danger-300')}>{label}</span>
            {entry.durationMs !== undefined ? (
              <span className="shrink-0 tabular-nums text-fg-subtle/70">{formatDuration(entry.durationMs)}</span>
            ) : null}
            {hasDetail ? (
              <button
                type="button"
                aria-expanded={open}
                aria-label={open ? 'Hide details' : 'Show details'}
                onClick={() => setOpen(v => !v)}
                className="shrink-0 text-fg-subtle hover:text-fg-muted"
              >
                <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
              </button>
            ) : null}
          </div>
          {failed && entry.error ? <div className="mt-0.5 text-danger-300">{entry.error}</div> : null}
          {open && hasDetail ? (
            <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-line bg-canvas/80 p-2 font-mono text-[10px] leading-[1.5] text-fg-muted">
              {JSON.stringify(entry.detail, null, 2)}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  )
}
