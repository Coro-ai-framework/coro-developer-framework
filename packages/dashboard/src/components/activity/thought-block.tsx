import { Brain } from 'lucide-react'
import { cn } from '../../lib/utils'

/** Dimmed reasoning, matching the job activity "Thinking" lines. */
export default function ThoughtBlock({
  text,
  streaming = false,
}: {
  text: string
  streaming?: boolean
}) {
  if (!text.trim()) return null
  return (
    <div className="flex items-start gap-3 text-[12.5px] leading-[1.65] text-fg-muted">
      <Brain className="mt-0.5 size-3.5 shrink-0 text-fg-subtle opacity-60" aria-hidden />
      <div className={cn('min-w-0 whitespace-pre-wrap opacity-80')}>
        <span className="mr-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-subtle">
          Thinking
        </span>
        {text}
        {streaming ? (
          <span
            className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] bg-fg-subtle/70 animate-pulse-dot"
            aria-hidden
          />
        ) : null}
      </div>
    </div>
  )
}
