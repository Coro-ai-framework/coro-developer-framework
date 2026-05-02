import type { LucideIcon } from 'lucide-react'
import { Card, CardHeader, CardTitle } from '../ui/card'
import { cn } from '../../lib/utils'
import type { AnyTone } from '../../lib/status'
import { normalizeTone } from '../../lib/status'

interface StatCardProps {
  label: string
  value: string
  description?: string
  icon?: LucideIcon
  tone?: AnyTone
  className?: string
}

const ICON_TONE: Record<ReturnType<typeof normalizeTone>, string> = {
  neutral: 'border-line-strong bg-overlay text-fg-muted',
  accent: 'border-accent-500/25 bg-accent-500/10 text-accent-300',
  success: 'border-success-500/25 bg-success-500/10 text-success-400',
  warning: 'border-warning-500/30 bg-warning-500/10 text-warning-400',
  danger: 'border-danger-500/30 bg-danger-500/10 text-danger-400',
}

export default function StatCard({ label, value, description, icon: Icon, tone = 'neutral', className }: StatCardProps) {
  const semanticTone = normalizeTone(tone)

  return (
    <Card className={cn('overflow-hidden', className)} title={description}>
      <CardHeader className="gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle">
              {label}
            </div>
            <CardTitle className="text-[1.6rem] sm:text-[1.75rem]">{value}</CardTitle>
          </div>
          {Icon ? (
            <div
              className={cn(
                'flex size-9 items-center justify-center rounded-xl border',
                ICON_TONE[semanticTone],
              )}
            >
              <Icon className="size-4" />
            </div>
          ) : null}
        </div>
        {description ? (
          <p className="text-[12px] leading-4 text-fg-subtle">{description}</p>
        ) : null}
      </CardHeader>
    </Card>
  )
}
