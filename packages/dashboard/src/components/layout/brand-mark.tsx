import { cn } from '../../lib/utils'

interface BrandMarkProps {
  /** When true the wordmark is hidden and only the geometric mark is shown. */
  iconOnly?: boolean
  className?: string
}

/**
 * Coro brand mark.
 *
 * The geometric symbol is two concentric arc segments that read as a stylised
 * "C" — open on the right, with a small accent dot tucked into the gap. It's
 * intentionally simple: vector-only, no PNG asset, scales cleanly at any size,
 * and inherits `currentColor` so it adapts to surrounding context.
 *
 * Pairs with a Space Grotesk wordmark for the full brand.
 */
export default function BrandMark({ iconOnly = false, className }: BrandMarkProps) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span
        aria-hidden
        className="relative inline-flex size-8 items-center justify-center rounded-xl bg-accent-500/12 ring-1 ring-accent-500/25"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className="size-4 text-accent-300"
        >
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
          <span className="text-[15px] font-semibold tracking-tight text-fg">Coro</span>
          <span className="mt-1 text-[10px] font-medium uppercase tracking-[0.22em] text-fg-subtle">
            Workbench
          </span>
        </span>
      )}
    </span>
  )
}
