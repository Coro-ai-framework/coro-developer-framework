import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { toneClasses, type Tone } from '../../lib/status'

export type SettingStatus =
  | 'ok'
  | 'warn'
  | 'error'
  | 'pending'
  | 'unset'
  | 'optional'

const TONE_BY_STATUS: Record<SettingStatus, Tone> = {
  ok: 'success',
  warn: 'warning',
  error: 'danger',
  pending: 'accent',
  unset: 'neutral',
  optional: 'neutral',
}

const DEFAULT_LABEL: Record<SettingStatus, string> = {
  ok: 'Ready',
  warn: 'Needs attention',
  error: 'Failed',
  pending: 'Working…',
  unset: 'Not set',
  optional: 'Optional',
}

interface SettingsStatusBadgeProps {
  status: SettingStatus
  label?: ReactNode
  className?: string
}

/**
 * Single source of truth for "is this section healthy?" badges in the
 * Settings UI. Used in the sidebar, in section headers, and in the
 * readiness card on Home so a user sees the same vocabulary everywhere.
 */
export default function SettingsStatusBadge({ status, label, className }: SettingsStatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-[0.16em]',
        toneClasses(TONE_BY_STATUS[status]),
        className,
      )}
    >
      {label ?? DEFAULT_LABEL[status]}
    </span>
  )
}
