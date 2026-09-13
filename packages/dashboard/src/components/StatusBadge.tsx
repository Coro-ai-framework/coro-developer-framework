import { Badge } from './ui/badge'
import {
  getJobDisplayStatus,
  toneClasses,
  toneDotClasses,
  type StatusMeta,
  type StatusSource,
} from '../lib/status'
import { cn } from '../lib/utils'

interface StatusBadgeProps extends Partial<StatusSource> {
  meta?: StatusMeta
  className?: string
}

export default function StatusBadge({ status, awaitingEvent, meta, className = '' }: StatusBadgeProps) {
  const resolved = meta ?? (status ? getJobDisplayStatus({ status, awaitingEvent }) : null)
  if (!resolved) return null

  return (
    <Badge variant="neutral" className={cn(toneClasses(resolved.tone), className)}>
      <span
        className={cn(
          'size-1.5 rounded-full',
          toneDotClasses(resolved.tone),
          resolved.pulse && 'animate-pulse-dot',
        )}
      />
      {resolved.label}
    </Badge>
  )
}
