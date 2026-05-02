import type { LucideIcon } from 'lucide-react'
import { Card, CardHeader, CardTitle } from '../ui/card'
import { cn } from '../../lib/utils'

interface StatCardProps {
  label: string
  value: string
  description?: string
  icon?: LucideIcon
  tone?: 'neutral' | 'indigo' | 'cyan' | 'violet' | 'emerald' | 'amber' | 'rose'
  className?: string
}

const TONE_STYLES: Record<NonNullable<StatCardProps['tone']>, string> = {
  neutral: 'border-white/10 bg-white/[0.03] text-slate-200',
  indigo: 'border-indigo-500/20 bg-indigo-500/8 text-indigo-100',
  cyan: 'border-cyan-500/20 bg-cyan-500/8 text-cyan-100',
  violet: 'border-violet-500/20 bg-violet-500/8 text-violet-100',
  emerald: 'border-emerald-500/20 bg-emerald-500/8 text-emerald-100',
  amber: 'border-amber-500/20 bg-amber-500/8 text-amber-100',
  rose: 'border-rose-500/20 bg-rose-500/8 text-rose-100',
}

export default function StatCard({ label, value, description, icon: Icon, tone = 'neutral', className }: StatCardProps) {
  return (
    <Card className={cn('overflow-hidden', className)} title={description}>
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">{label}</div>
            <CardTitle className="text-[1.75rem] sm:text-[1.9rem]">{value}</CardTitle>
          </div>
          {Icon ? (
            <div className={cn('flex size-10 items-center justify-center rounded-xl border', TONE_STYLES[tone])}>
              <Icon className="size-5" />
            </div>
          ) : null}
        </div>
      </CardHeader>
    </Card>
  )
}