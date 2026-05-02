import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.12em]',
  {
    variants: {
      variant: {
        neutral: 'border-white/10 bg-white/6 text-slate-200',
        indigo: 'border-indigo-500/35 bg-indigo-500/12 text-indigo-100',
        cyan: 'border-cyan-500/35 bg-cyan-500/12 text-cyan-100',
        violet: 'border-violet-500/35 bg-violet-500/12 text-violet-100',
        emerald: 'border-emerald-500/35 bg-emerald-500/12 text-emerald-100',
        amber: 'border-amber-500/35 bg-amber-500/12 text-amber-100',
        rose: 'border-rose-500/35 bg-rose-500/12 text-rose-100',
      },
    },
    defaultVariants: {
      variant: 'neutral',
    },
  },
)

interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }