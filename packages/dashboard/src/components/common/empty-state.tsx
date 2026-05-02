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
    <Card className={cn('border-dashed', className)}>
      <CardContent className="flex flex-col items-center justify-center gap-4 py-12 text-center">
        <div className="rounded-2xl border border-white/8 bg-white/5 p-4 text-slate-300">
          <Icon className="size-6" />
        </div>
        <div className="space-y-1.5">
          <div className="text-lg font-semibold text-white">{title}</div>
          <p className="mx-auto max-w-md text-sm text-slate-400">{description}</p>
        </div>
        {action}
      </CardContent>
    </Card>
  )
}