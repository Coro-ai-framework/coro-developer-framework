import { Badge } from './ui/badge'
import { getStatusMeta, toneClasses, toneDotClasses } from '../lib/status'

interface StatusBadgeProps {
  status: string
  className?: string
}

export default function StatusBadge({ status, className = '' }: StatusBadgeProps) {
  const meta = getStatusMeta(status)

  return (
    <Badge variant="neutral" className={`${toneClasses(meta.tone)} ${className}`}>
      <span className={`size-1.5 rounded-full ${toneDotClasses(meta.tone)} ${meta.pulse ? 'animate-pulse-dot' : ''}`} />
      {meta.label}
    </Badge>
  )
}
