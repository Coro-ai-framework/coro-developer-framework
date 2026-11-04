import pino from 'pino'
import { loadLocalConfig } from '../../src/config/local-config'
import { runReviewOnce } from '../../src/reviews/once'

export async function runHeadless(pr: string, failOn?: string): Promise<number> {
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })
  return runReviewOnce({
    config: loadLocalConfig(),
    logger,
    prUrl: pr,
    ...(failOn === 'blocker' ? { failOn: 'blocker' as const } : {}),
  })
}
