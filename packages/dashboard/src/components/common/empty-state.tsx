import type { LucideIcon } from 'lucide-react'
import { Card, CardContent } from '../ui/card'
import { cn } from '../../lib/utils'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?: React.ReactNode
  className?: string
}

export default function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <Card className={cn('border-dashed border-line-strong bg-transparent shadow-none', className)}>
      <CardContent className="flex flex-col items-center justify-center gap-4 py-12 text-center">
        <div className="rounded-2xl border border-line-strong bg-overlay p-3 text-fg-muted">
          <Icon className="size-5" />
        </div>
        <div className="space-y-1.5">
          <div className="text-base font-semibold text-fg">{title}</div>
          <p className="mx-auto max-w-md text-sm text-fg-muted">{description}</p>
        </div>
        {action}
      </CardContent>
    </Card>
  )
}
