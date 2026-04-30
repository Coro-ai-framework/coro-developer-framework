const STATUS_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  'queued':                    { bg: 'bg-zinc-800', text: 'text-zinc-300', dot: 'bg-zinc-400' },
  'coding':                    { bg: 'bg-indigo-950', text: 'text-indigo-300', dot: 'bg-indigo-400' },
  'planning':                  { bg: 'bg-violet-950', text: 'text-violet-300', dot: 'bg-violet-400' },
  'testing':                   { bg: 'bg-cyan-950', text: 'text-cyan-300', dot: 'bg-cyan-400' },
  'review':                    { bg: 'bg-amber-950', text: 'text-amber-300', dot: 'bg-amber-400' },
  'awaiting-plan-approval':    { bg: 'bg-amber-950', text: 'text-amber-300', dot: 'bg-amber-400' },
  'awaiting-pr-merge':         { bg: 'bg-amber-950', text: 'text-amber-300', dot: 'bg-amber-400' },
  'awaiting-developer-input':  { bg: 'bg-amber-950', text: 'text-amber-300', dot: 'bg-amber-400' },
  'awaiting-children':         { bg: 'bg-sky-950', text: 'text-sky-300', dot: 'bg-sky-400' },
  'campaign-planning':         { bg: 'bg-violet-950', text: 'text-violet-300', dot: 'bg-violet-400' },
  'coordinating':              { bg: 'bg-sky-950', text: 'text-sky-300', dot: 'bg-sky-400' },
  'aggregating':               { bg: 'bg-emerald-950', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  'complete':                  { bg: 'bg-emerald-950', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  'failed':                    { bg: 'bg-rose-950', text: 'text-rose-300', dot: 'bg-rose-400' },
  'escalated':                 { bg: 'bg-rose-950', text: 'text-rose-300', dot: 'bg-rose-400' },
}

const ACTIVE_STATUSES = new Set(['coding', 'planning', 'testing', 'review', 'queued'])

interface StatusBadgeProps {
  status: string
  className?: string
}

export default function StatusBadge({ status, className = '' }: StatusBadgeProps) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES['queued']
  const isActive = ACTIVE_STATUSES.has(status)

  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${style.bg} ${style.text} ${className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot} ${isActive ? 'animate-pulse-dot' : ''}`} />
      {status}
    </span>
  )
}
