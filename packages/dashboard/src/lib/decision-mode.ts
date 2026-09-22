import type { DecisionMode } from '../types'

/** User-facing name. The stored value stays `shadow` or `live`. */
export function decisionModeLabel(mode: DecisionMode | '' | undefined): string {
  if (mode === 'shadow') return 'Observe'
  if (mode === 'live') return 'Manage'
  if (mode === 'off') return 'Off'
  return 'Inherit'
}

export const OBSERVE_SUMMARY =
  'Records whether each phase is still on track. The job keeps running, and you see the rating.'

export const MANAGE_SUMMARY =
  'The same check can pause an interactive job when it looks off track, so you can look before more work continues.'
