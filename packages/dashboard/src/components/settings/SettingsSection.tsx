import type { ReactNode } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'
import { cn } from '../../lib/utils'
import SettingsStatusBadge, { type SettingStatus } from './StatusBadge'

interface SettingsSectionProps {
  title: string
  description?: ReactNode
  status?: SettingStatus
  statusLabel?: ReactNode
  required?: boolean
  action?: ReactNode
  footer?: ReactNode
  className?: string
  children: ReactNode
}

/**
 * Standard card scaffolding for any section inside a Settings page.
 * Every section uses the same template — title row, optional status
 * pill, body, optional footer — so the page reads as a list rather
 * than a collage.
 */
export default function SettingsSection({
  title,
  description,
  status,
  statusLabel,
  required,
  action,
  footer,
  className,
  children,
}: SettingsSectionProps) {
  return (
    <Card className={className}>
      <CardHeader className={cn('gap-3 border-b border-line pb-4', action ? 'sm:flex-row sm:items-start sm:justify-between' : '')}>
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle>{title}</CardTitle>
            {required ? (
              <span className="rounded-full border border-line bg-overlay/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
                Required
              </span>
            ) : null}
            {status ? <SettingsStatusBadge status={status} label={statusLabel} /> : null}
          </div>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </CardHeader>
      <CardContent className="space-y-5 pt-5">{children}</CardContent>
      {footer ? <div className="border-t border-line bg-overlay/30 px-6 py-3 text-xs text-fg-subtle">{footer}</div> : null}
    </Card>
  )
}
