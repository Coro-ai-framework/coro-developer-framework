import {
  loadLocalConfig,
  mergeLocalConfig,
  type LocalConfig,
} from '../config/local-config'

const DEFAULT_GRADUATE_AFTER = 5

export function incrementCoachModeRunCount(configPath?: string): void {
  const existing: LocalConfig = loadLocalConfig(configPath) ?? {}
  const coach = existing.coachMode ?? {}
  mergeLocalConfig(
    {
      coachMode: {
        enabled: coach.enabled ?? true,
        graduateAfterRuns: coach.graduateAfterRuns ?? DEFAULT_GRADUATE_AFTER,
        totalRuns: (coach.totalRuns ?? 0) + 1,
        lastRunAt: new Date().toISOString(),
        ...(coach.graduatedAt ? { graduatedAt: coach.graduatedAt } : {}),
      },
    },
    configPath,
  )
}
