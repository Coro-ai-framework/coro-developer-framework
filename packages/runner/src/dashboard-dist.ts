import fs from 'fs'
import path from 'path'
import { createRequire } from 'node:module'
import type { Logger } from 'pino'

const nodeRequire = createRequire(__filename)

/**
 * Resolve the built dashboard directory (`packages/dashboard/dist/`).
 *
 * Resolution order (first existing match wins):
 *   1. `CORO_DASHBOARD_DIST` env override (used by container images / packaged
 *      desktop builds where the layout is non-standard).
 *   2. Installed `@coro/dashboard` npm package (`node_modules/@coro/dashboard/dist`).
 *   3. Monorepo / dev clone paths walked relative to this module's `__dirname`
 *      so we work in both compiled and ts-node/tsx layouts.
 *
 * Returns `null` if no build is found so callers can serve a friendly 503
 * (or other fallback) instead of crashing the runner.
 */
export function resolveDashboardDist(logger: Logger): string | null {
  const fromEnv = process.env['CORO_DASHBOARD_DIST']
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'index.html'))) return fromEnv

  const fromPackage = resolveDashboardFromInstalledPackage()
  if (fromPackage) return fromPackage

  const bundledCandidates = [
    path.resolve(__dirname, '../../../dashboard-dist'),
    path.resolve(__dirname, '../../../../dashboard-dist'),
  ]
  for (const candidate of bundledCandidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate
  }

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
    'Dashboard build not found; /dashboard will return 503. Install @coro/dashboard or run `pnpm --filter @coro/dashboard build`.',
  )
  return null
}

function resolveDashboardFromInstalledPackage(): string | null {
  try {
    const pkgJson = nodeRequire.resolve('@coro/dashboard/package.json')
    const dist = path.join(path.dirname(pkgJson), 'dist')
    if (fs.existsSync(path.join(dist, 'index.html'))) return dist
  } catch {
    // @coro/dashboard not installed — expected in monorepo dev without npm link
  }
  return null
}
