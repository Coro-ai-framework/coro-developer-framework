import { cn } from '../lib/utils'

interface BrandMarkProps {
  iconOnly?: boolean
  className?: string
}

export function BrandMark({ iconOnly = false, className }: BrandMarkProps) {
  return (
    <span className={cn('inline-flex items-center gap-3', className)}>
      <span
        aria-hidden
        className="relative inline-flex size-9 items-center justify-center rounded-2xl bg-accent-500/15 ring-1 ring-accent-400/30 shadow-[0_0_32px_rgba(97,114,255,0.22)]"
      >
        <svg viewBox="0 0 24 24" fill="none" className="size-5 text-accent-300">
          <path
            d="M19 7.5A8 8 0 1 0 19 16.5"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
          <circle cx="18.25" cy="12" r="1.6" fill="currentColor" />
        </svg>
      </span>
      {iconOnly ? null : (
        <span className="flex flex-col leading-none">
          <span className="text-base font-semibold tracking-tight text-fg">Coro</span>
          <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-fg-subtle">
            AI Harness
          </span>
        </span>
      )}
    </span>
  )
}
