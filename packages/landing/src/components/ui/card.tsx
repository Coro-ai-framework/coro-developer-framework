import * as React from 'react'
import { cn } from '../../lib/utils'

export function Card({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'rounded-3xl border border-line bg-panel/70 shadow-[var(--shadow-card)] backdrop-blur-xl',
        className,
      )}
      {...props}
    />
  )
}

export function FeatureCard({ className, ...props }: React.ComponentProps<'article'>) {
  return (
    <article
      className={cn(
        'rounded-2xl border border-line bg-white/[0.035] p-6 shadow-[var(--shadow-card)] transition duration-200 hover:border-line-strong hover:bg-white/[0.055]',
        className,
      )}
      {...props}
    />
  )
}
