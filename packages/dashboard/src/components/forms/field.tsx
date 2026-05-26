import type { ReactNode } from 'react'
import { HelpCircle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { cn } from '../../lib/utils'

interface FieldProps {
  label: string
  htmlFor?: string
  required?: boolean
  hint?: ReactNode
  /** Extended help shown in a tooltip on the label. */
  tooltip?: ReactNode
  className?: string
  children: ReactNode
}

export default function Field({ label, htmlFor, required, hint, tooltip, className, children }: FieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center gap-1.5">
        <label htmlFor={htmlFor} className="block text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle">
          {label}
          {required ? <span className="ml-1 text-danger-400">*</span> : null}
        </label>
        {tooltip ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex text-fg-subtle transition-colors hover:text-fg-muted"
                aria-label={`More about ${label}`}
              >
                <HelpCircle className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs leading-relaxed">{tooltip}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {children}
      {hint ? <div className="text-xs leading-5 text-fg-subtle">{hint}</div> : null}
    </div>
  )
}
