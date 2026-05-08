import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import { toneClasses, type Tone } from '../../lib/status'

const ICON_BY_TONE = {
  neutral: Info,
  accent: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
} as const

interface SettingsNoticeProps {
  tone?: Tone
  title?: ReactNode
  children: ReactNode
  className?: string
}

/**
 * A tone-consistent notice block. Replaces the ~15 ad-hoc rounded
 * boxes that the old Settings page hand-rolled, so colour and spacing
 * stay aligned across every section.
 */
export default function SettingsNotice({ tone = 'neutral', title, children, className }: SettingsNoticeProps) {
  const Icon = ICON_BY_TONE[tone]
  return (
    <div className={cn('flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm', toneClasses(tone), className)}>
      <Icon className="size-4 shrink-0 translate-y-0.5" />
      <div className="space-y-1">
        {title ? <div className="font-medium">{title}</div> : null}
        <div className="text-fg-muted">{children}</div>
      </div>
    </div>
  )
}
