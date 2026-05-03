import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface FieldProps {
  label: string
  required?: boolean
  hint?: ReactNode
  className?: string
  children: ReactNode
}

export default function Field({ label, required, hint, className, children }: FieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <label className="block text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle">
        {label}
        {required ? <span className="ml-1 text-danger-400">*</span> : null}
      </label>
      {children}
      {hint ? <div className="text-xs leading-5 text-fg-subtle">{hint}</div> : null}
    </div>
  )
}
