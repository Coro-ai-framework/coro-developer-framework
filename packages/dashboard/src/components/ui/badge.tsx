import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.12em]',
  {
    variants: {
      variant: {
        neutral: 'border-line-strong bg-overlay text-fg-muted',
        accent: 'border-accent-500/30 bg-accent-500/10 text-accent-300',
        success: 'border-success-500/30 bg-success-500/10 text-success-400',
        warning: 'border-warning-500/30 bg-warning-500/10 text-warning-400',
        danger: 'border-danger-500/30 bg-danger-500/10 text-danger-400',
        // Legacy aliases — map to the semantic vocabulary above. Kept so we
        // can migrate call sites incrementally without breaking compilation.
        indigo: 'border-accent-500/30 bg-accent-500/10 text-accent-300',
        cyan: 'border-accent-500/30 bg-accent-500/10 text-accent-300',
        violet: 'border-accent-500/30 bg-accent-500/10 text-accent-300',
        emerald: 'border-success-500/30 bg-success-500/10 text-success-400',
        amber: 'border-warning-500/30 bg-warning-500/10 text-warning-400',
        rose: 'border-danger-500/30 bg-danger-500/10 text-danger-400',
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
