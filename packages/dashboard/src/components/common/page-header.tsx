import { cn } from '../../lib/utils'

interface PageHeaderProps {
  /**
   * Optional small uppercase label rendered above the title. Use sparingly —
   * most pages don't need this once the sidebar already names the section.
   */
  eyebrow?: string
  title: string
  description?: string
  actions?: React.ReactNode
  className?: string
}

export default function PageHeader({ eyebrow, title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between', className)}>
      <div className="space-y-1">
        {eyebrow ? (
          <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
            {eyebrow}
          </div>
        ) : null}
        <div className="space-y-1">
          <h1 className="text-[1.75rem] font-semibold tracking-tight text-fg sm:text-[2rem]">
            {title}
          </h1>
          {description ? (
            <p className="max-w-2xl text-sm leading-5 text-fg-muted">{description}</p>
          ) : null}
        </div>
      </div>

      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  )
}
