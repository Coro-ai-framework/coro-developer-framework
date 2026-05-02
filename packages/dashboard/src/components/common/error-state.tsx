import { TriangleAlert } from 'lucide-react'
import { cn } from '../../lib/utils'

interface ErrorStateProps {
  title?: string
  message: string
  className?: string
  action?: React.ReactNode
}

/**
 * Centralized inline error pattern. Replaces the rose-bordered divs that
 * each page currently inlines, so the visual treatment of "something went
 * wrong" stays consistent across the app.
 */
export default function ErrorState({ title, message, className, action }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-3 rounded-2xl border border-danger-500/25 bg-danger-500/8 px-4 py-3 text-sm text-danger-400',
        className,
      )}
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <div className="font-medium text-danger-400">{title}</div> : null}
        <p className="leading-5 text-fg-muted">{message}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
