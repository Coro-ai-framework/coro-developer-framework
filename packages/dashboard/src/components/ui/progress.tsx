import { cn } from '../../lib/utils'

interface ProgressProps {
  value: number
  className?: string
  indicatorClassName?: string
}

export default function Progress({ value, className, indicatorClassName }: ProgressProps) {
  return (
    <div className={cn('relative h-1.5 overflow-hidden rounded-full bg-overlay', className)}>
      <div
        className={cn('h-full rounded-full bg-accent-400 transition-[width]', indicatorClassName)}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  )
}
