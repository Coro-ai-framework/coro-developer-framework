import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Semver of `@coro-ai/runner` as shipped. Read from the package next to
 * this file so dist and src resolve the same `package.json`. Falls back
 * to a placeholder only when the file is missing (tests that copy a
 * stub dist tree).
 */
export function runnerVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}
