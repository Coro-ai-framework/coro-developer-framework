import { useEffect } from 'react'
import { CheckCircle2, TriangleAlert, X } from 'lucide-react'
import { cn } from '../../lib/utils'

export interface Notice {
  tone: 'success' | 'danger'
  message: string
}

/** A dismissible result line for an action. Success fades on its own; errors stay until dismissed. */
export default function NoticeBanner({ notice, onDismiss }: { notice: Notice | null; onDismiss: () => void }) {
  useEffect(() => {
    if (notice?.tone !== 'success') return
    const timer = setTimeout(onDismiss, 5000)
    return () => clearTimeout(timer)
  }, [notice, onDismiss])

  if (!notice) return null
  const Icon = notice.tone === 'success' ? CheckCircle2 : TriangleAlert
  return (
    <div
      role={notice.tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm',
        notice.tone === 'success'
          ? 'border-success-500/25 bg-success-500/8 text-success-400'
          : 'border-danger-500/25 bg-danger-500/8 text-danger-400',
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <p className="min-w-0 flex-1 leading-5 text-fg-muted">{notice.message}</p>
      <button type="button" onClick={onDismiss} className="rounded p-0.5 text-fg-subtle hover:text-fg" aria-label="Dismiss">
        <X className="size-4" />
      </button>
    </div>
  )
}
