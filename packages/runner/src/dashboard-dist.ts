import fs from 'fs'
import path from 'path'
import type { Logger } from 'pino'

/**
 * Resolve the built dashboard directory (`packages/dashboard/dist/`).
 *
 * Resolution order (first existing match wins):
 *   1. `CORO_DASHBOARD_DIST` env override (used by container images / packaged
 *      desktop builds where the layout is non-standard).
 *   2. A set of candidate paths walked relative to this module's `__dirname`
 *      so we work in both compiled and ts-node/tsx layouts:
 *        • ts-node/tsx:  packages/runner/src/             → ../dashboard/dist
 *        • compiled:     packages/runner/dist/src/        → ../../dashboard/dist
 *        • compiled-deep: packages/runner/dist/src/runner → ../../../dashboard/dist
 *
 * Returns `null` if no build is found so callers can serve a friendly 503
 * (or other fallback) instead of crashing the runner.
 */
export function resolveDashboardDist(logger: Logger): string | null {
  const fromEnv = process.env['CORO_DASHBOARD_DIST']
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'index.html'))) return fromEnv

  const candidates = [
    // ts-node / tsx (src/<file>.ts → packages/dashboard/dist)
    path.resolve(__dirname, '../../dashboard/dist'),
    // ts-node / tsx (src/<sub>/<file>.ts → packages/dashboard/dist)
    path.resolve(__dirname, '../../../dashboard/dist'),
    // compiled (dist/src/<file>.js → packages/dashboard/dist)
    path.resolve(__dirname, '../../../dashboard/dist'),
    // compiled (dist/src/<sub>/<file>.js → packages/dashboard/dist)
    path.resolve(__dirname, '../../../../dashboard/dist'),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate
  }

  logger.warn(
    { candidates: Array.from(new Set(candidates)) },
    'Dashboard build not found; /dashboard will return 503. Run `pnpm --filter @coro/dashboard build`.',
  )
  return null
}
