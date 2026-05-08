import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

export interface ChoiceOption<T extends string> {
  value: T
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  badge?: ReactNode
}

interface ChoiceGroupProps<T extends string> {
  name?: string
  value: T
  options: ChoiceOption<T>[]
  onChange: (value: T) => void
  /** Number of columns at md+; default 3. */
  cols?: 1 | 2 | 3 | 4
  className?: string
}

const COLS_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: 'md:grid-cols-1',
  2: 'md:grid-cols-2',
  3: 'md:grid-cols-3',
  4: 'md:grid-cols-2 xl:grid-cols-4',
}

/**
 * A radio-group dressed as tappable cards. Used for "pick one of
 * these" choices like the LLM auth method, the SCM provider, the
 * tracker provider — wherever the old Settings page used a
 * ChoiceButton or a `<select>`.
 *
 * Renders real radio inputs under the hood so screen readers
 * announce "1 of 3" and arrow-key navigation works.
 */
export default function ChoiceGroup<T extends string>({
  name,
  value,
  options,
  onChange,
  cols = 3,
  className,
}: ChoiceGroupProps<T>) {
  const groupName = name ?? `choice-${Math.random().toString(36).slice(2, 8)}`
  return (
    <div role="radiogroup" className={cn('grid gap-3', COLS_CLASS[cols], className)}>
      {options.map(option => {
        const active = option.value === value
        return (
          <label
            key={option.value}
            className={cn(
              'cursor-pointer rounded-2xl border px-4 py-3 text-left text-sm transition-colors',
              active
                ? 'border-accent-500/40 bg-accent-500/8 text-fg ring-1 ring-accent-500/30'
                : 'border-line bg-overlay/40 text-fg-muted hover:border-line-strong hover:text-fg',
              option.disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              type="radio"
              name={groupName}
              value={option.value}
              checked={active}
              disabled={option.disabled}
              onChange={() => !option.disabled && onChange(option.value)}
              className="sr-only"
            />
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium text-fg">{option.label}</div>
              {option.badge}
            </div>
            {option.description ? (
              <div className="mt-1 text-fg-muted">{option.description}</div>
            ) : null}
          </label>
        )
      })}
    </div>
  )
}
