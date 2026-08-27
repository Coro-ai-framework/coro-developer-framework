import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Semver of `@coro-ai/runner` as shipped. `src/version.ts` compiles to
 * `dist/src/version.js` (`rootDir` is the package), so the package.json
 * is one directory up from source and two up from dist. Falls back to a
 * placeholder only when neither is readable.
 */
export function runnerVersion(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'package.json'),
    path.resolve(__dirname, '..', '..', 'package.json'),
  ]
  for (const pkgPath of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string }
      if (pkg.name === '@coro-ai/runner' && typeof pkg.version === 'string' && pkg.version.length > 0) {
        return pkg.version
      }
    } catch {
      // Try the next candidate.
    }
  }
  return '0.0.0'
}
