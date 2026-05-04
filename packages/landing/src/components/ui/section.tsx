import * as React from 'react'
import { cn } from '../../lib/utils'

interface SectionProps extends React.ComponentProps<'section'> {
  eyebrow?: string
  title?: string
  description?: string
}

export function Section({
  eyebrow,
  title,
  description,
  className,
  children,
  ...props
}: SectionProps) {
  return (
    <section className={cn('mx-auto w-full max-w-7xl px-6 py-20 sm:px-8', className)} {...props}>
      {(eyebrow || title || description) && (
        <div className="mx-auto mb-12 max-w-3xl text-center">
          {eyebrow && (
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.32em] text-accent-300">
              {eyebrow}
            </p>
          )}
          {title && (
            <h2 className="text-3xl font-semibold tracking-[-0.04em] text-fg sm:text-5xl">
              {title}
            </h2>
          )}
          {description && (
            <p className="mx-auto mt-5 max-w-2xl text-base leading-8 text-fg-muted sm:text-lg">
              {description}
            </p>
          )}
        </div>
      )}
      {children}
    </section>
  )
}
