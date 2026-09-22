import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { readOnTrack } from '../../lib/on-track'
import { toneClasses, toneDotClasses } from '../../lib/status'
import { badgeVariants } from '../ui/badge'
import { cn } from '../../lib/utils'
import type { DecisionRecord } from '../../types'

export default function OnTrackIndicator({ records }: { records: DecisionRecord[] | undefined }) {
  const readout = readOnTrack(records)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!readout) return null

  const confidenceLabel = readout.confidence === null ? readout.label : `${readout.label}, ${readout.confidence}%`

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${confidenceLabel}. ${open ? 'Hide' : 'Show'} the check`}
        onClick={() => setOpen(current => !current)}
        className={cn(
          badgeVariants({ variant: 'neutral' }),
          toneClasses(readout.tone),
          // Buttons inherit the page font, which made this pill taller than StatusBadge.
          'text-[11px]! font-medium! leading-normal! tracking-[0.12em]!',
        )}
      >
        <span className={cn('size-1.5 shrink-0 rounded-full', toneDotClasses(readout.tone))} />
        {readout.label}
        {readout.confidence !== null ? (
          <span className="tabular-nums tracking-normal!">{readout.confidence}%</span>
        ) : null}
        <ChevronDown className={cn('size-2.5 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Is this run on track"
          className="absolute left-0 top-full z-50 mt-2 w-80 rounded-xl border border-line-strong bg-panel-raised p-4 text-left shadow-[var(--shadow-elevated)] normal-case tracking-normal"
        >
          <div className="flex items-baseline gap-2">
            {readout.confidence !== null ? (
              <p className="text-2xl font-semibold tabular-nums text-fg">{readout.confidence}%</p>
            ) : null}
            <p className="text-sm font-medium text-fg">{readout.label}</p>
          </div>
          {readout.confidence !== null ? (
            <p className="mt-1 text-[12px] leading-5 text-fg-subtle">
              How sure we are this run is still on its goal. 70% or more is on track. Under 40% is off track.
            </p>
          ) : null}
          <p className="mt-1 text-[13px] leading-5 text-fg-muted">{readout.summary}</p>
          {readout.lines.length > 0 ? (
            <dl className="mt-3 space-y-2">
              {readout.lines.map(line => (
                <div key={line.label} className="flex gap-3 text-[13px]">
                  <dt className="w-24 shrink-0 text-fg-subtle">{line.label}</dt>
                  <dd className="text-fg">{line.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <p className="mt-3 text-[11px] text-fg-subtle">Checked after {readout.checkedAfter}</p>
          {readout.earlier.length > 0 ? (
            <ul className="mt-2 space-y-1 text-[12px] text-fg-muted">
              {readout.earlier.map(item => (
                <li key={`${item.phase}-${item.label}`}>
                  After {item.phase}: {item.label.toLowerCase()}
                  {item.confidence !== null ? ` · ${item.confidence}%` : ''}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
