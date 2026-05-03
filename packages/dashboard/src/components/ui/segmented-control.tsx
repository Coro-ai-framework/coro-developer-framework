import { cn } from '../../lib/utils'

interface SegmentedControlOption<T extends string> {
  value: T
  label: string
}

interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedControlOption<T>>
  value: T
  onChange: (value: T) => void
  size?: 'sm' | 'md'
  className?: string
  /** Optional accessible label for the radiogroup. */
  ariaLabel?: string
}

/**
 * Pill-style segmented control. Replaces the ad-hoc rounded-full button rows
 * that JobList, History, and similar pages currently inline with raw `<button>`
 * elements and bespoke class strings.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  className,
  ariaLabel,
}: SegmentedControlProps<T>) {
  const itemSize = size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3 py-1.5 text-sm'

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-line bg-overlay/60 p-1',
        className,
      )}
    >
      {options.map(option => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-full font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60',
              itemSize,
              active
                ? 'bg-panel-raised text-fg shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]'
                : 'text-fg-muted hover:text-fg',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export default SegmentedControl
