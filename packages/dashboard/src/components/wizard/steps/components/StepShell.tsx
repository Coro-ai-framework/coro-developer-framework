import type { ReactNode } from 'react'

interface StepShellProps {
  eyebrow: string
  title: string
  /** Description shown under the title. Kept short. */
  description: ReactNode
  /** Main step content. */
  children: ReactNode
  /** Optional inline aside on the right (e.g. step preview). */
  aside?: ReactNode
}

/**
 * Visual container for every non-welcome wizard step. Owns the
 * eyebrow + headline + description layout so steps only worry about
 * their body content.
 */
export default function StepShell({ eyebrow, title, description, children, aside }: StepShellProps) {
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-subtle">{eyebrow}</div>
        <h2 className="text-balance text-xl font-semibold tracking-tight text-fg sm:text-2xl">{title}</h2>
        <p className="max-w-2xl text-pretty text-sm text-fg-muted">{description}</p>
      </div>

      {aside ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div>{children}</div>
          <div className="lg:max-w-[260px]">{aside}</div>
        </div>
      ) : (
        children
      )}
    </div>
  )
}
