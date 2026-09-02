/** Coach mode preferences mirrored from server config (~/.coro/config.json). */

export interface CoachModeConfig {
  enabled?: boolean
  graduateAfterRuns?: number
  totalRuns?: number
  lastRunAt?: string
  graduatedAt?: string
}

export interface IntakeConfig {
  toolsEnabled?: boolean
}

export const DEFAULT_COACH_MODE: Required<Pick<CoachModeConfig, 'enabled' | 'graduateAfterRuns'>> = {
  enabled: true,
  graduateAfterRuns: 5,
}

export function resolveCoachMode(raw?: CoachModeConfig | null): Required<CoachModeConfig> {
  return {
    enabled: raw?.enabled ?? DEFAULT_COACH_MODE.enabled,
    graduateAfterRuns: raw?.graduateAfterRuns ?? DEFAULT_COACH_MODE.graduateAfterRuns,
    totalRuns: raw?.totalRuns ?? 0,
    lastRunAt: raw?.lastRunAt ?? '',
    graduatedAt: raw?.graduatedAt ?? '',
  }
}

export function isCoachModeActive(coach: CoachModeConfig | null | undefined): boolean {
  const resolved = resolveCoachMode(coach)
  return resolved.enabled && !resolved.graduatedAt
}

export function shouldShowCoachBanner(coach: CoachModeConfig | null | undefined): boolean {
  const resolved = resolveCoachMode(coach)
  return (
    resolved.enabled &&
    !resolved.graduatedAt &&
    resolved.totalRuns < resolved.graduateAfterRuns
  )
}

export function shouldShowGraduationCard(coach: CoachModeConfig | null | undefined): boolean {
  const resolved = resolveCoachMode(coach)
  return (
    resolved.enabled &&
    !resolved.graduatedAt &&
    resolved.totalRuns >= resolved.graduateAfterRuns
  )
}
