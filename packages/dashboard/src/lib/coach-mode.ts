/** Coach mode + intake preferences mirrored from server config (~/.coro/config.json). */

export type IntakeMode = 'ai' | 'form' | 'ask-each-time'

export interface CoachModeConfig {
  enabled?: boolean
  graduateAfterRuns?: number
  totalRuns?: number
  lastRunAt?: string
  graduatedAt?: string
}

export interface IntakeConfig {
  mode?: IntakeMode
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

export function defaultIntakeMode(coach: CoachModeConfig | null | undefined): IntakeMode {
  if (isCoachModeActive(coach)) return 'ai'
  return 'form'
}

export function resolveIntakeMode(
  intake: IntakeConfig | null | undefined,
  coach: CoachModeConfig | null | undefined,
): IntakeMode {
  return intake?.mode ?? defaultIntakeMode(coach)
}

export const INTAKE_MODE_CHOICE_KEY = 'coro.intake.modeChoice'
export const INTAKE_ASK_EACH_TIME_KEY = 'coro.intake.askEachTimeChoice'

export function loadSessionIntakeOverride(): IntakeMode | null {
  if (typeof window === 'undefined') return null
  const v = window.sessionStorage.getItem(INTAKE_MODE_CHOICE_KEY)
  if (v === 'ai' || v === 'form') return v
  return null
}

export function saveSessionIntakeOverride(mode: IntakeMode): void {
  if (typeof window === 'undefined') return
  window.sessionStorage.setItem(INTAKE_MODE_CHOICE_KEY, mode)
}

export function clearSessionIntakeOverride(): void {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(INTAKE_MODE_CHOICE_KEY)
}

export function loadAskEachTimeChoice(): 'ai' | 'form' | null {
  if (typeof window === 'undefined') return null
  const v = window.localStorage.getItem(INTAKE_ASK_EACH_TIME_KEY)
  if (v === 'ai' || v === 'form') return v
  return null
}

export function saveAskEachTimeChoice(mode: 'ai' | 'form'): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(INTAKE_ASK_EACH_TIME_KEY, mode)
}
