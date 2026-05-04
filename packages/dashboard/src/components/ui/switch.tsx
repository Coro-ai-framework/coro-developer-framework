import { cn } from '../../lib/utils'

interface SwitchProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  ariaLabel?: string
  size?: 'sm' | 'md'
  className?: string
}

/**
 * Minimal accessible toggle. Matches the shape of Radix's Switch so it can
 * be swapped out later without touching consumers — but we don't pull in a
 * new dependency just for one component.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  ariaLabel,
  size = 'md',
  className,
}: SwitchProps) {
  const handleToggle = () => {
    if (disabled) return
    onCheckedChange(!checked)
  }

  const sizeClasses =
    size === 'sm'
      ? { track: 'h-4 w-7', thumb: 'size-3', translate: 'translate-x-3' }
      : { track: 'h-5 w-9', thumb: 'size-4', translate: 'translate-x-4' }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={handleToggle}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60',
        'disabled:cursor-not-allowed disabled:opacity-50',
        sizeClasses.track,
        checked ? 'bg-accent-500' : 'bg-overlay ring-1 ring-line-strong',
        className,
      )}
    >
      <span
        className={cn(
          'inline-block transform rounded-full bg-white shadow transition-transform',
          sizeClasses.thumb,
          checked ? sizeClasses.translate : 'translate-x-0.5',
        )}
      />
    </button>
  )
}
