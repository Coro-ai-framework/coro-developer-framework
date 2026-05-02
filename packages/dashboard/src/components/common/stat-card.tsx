import type { LucideIcon } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
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
  neutral: 'from-white/7 to-white/3 text-slate-100',
  indigo: 'from-indigo-500/15 to-transparent text-indigo-100',
  cyan: 'from-cyan-500/15 to-transparent text-cyan-100',
  violet: 'from-violet-500/15 to-transparent text-violet-100',
  emerald: 'from-emerald-500/15 to-transparent text-emerald-100',
  amber: 'from-amber-500/15 to-transparent text-amber-100',
  rose: 'from-rose-500/15 to-transparent text-rose-100',
}

export default function StatCard({ label, value, description, icon: Icon, tone = 'neutral', className }: StatCardProps) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <CardHeader className={cn('gap-4 bg-gradient-to-br', TONE_STYLES[tone])}>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">{label}</div>
            <CardTitle className="text-3xl sm:text-[2rem]">{value}</CardTitle>
          </div>
          {Icon ? (
            <div className="rounded-2xl border border-white/8 bg-white/6 p-3 text-slate-200">
              <Icon className="size-5" />
            </div>
          ) : null}
        </div>
      </CardHeader>
      {description ? (
        <CardContent>
          <p className="text-sm text-slate-400">{description}</p>
        </CardContent>
      ) : null}
    </Card>
  )
}