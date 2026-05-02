import { cn } from '../../lib/utils'

interface ProgressProps {
  value: number
  className?: string
  indicatorClassName?: string
}

export default function Progress({ value, className, indicatorClassName }: ProgressProps) {
  return (
    <div className={cn('relative h-2.5 overflow-hidden rounded-full bg-white/6', className)}>
      <div
        className={cn('h-full rounded-full bg-gradient-to-r from-indigo-400 via-cyan-400 to-emerald-400 transition-[width]', indicatorClassName)}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  )
}