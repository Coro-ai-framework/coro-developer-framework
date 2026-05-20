import fs from 'node:fs'
import path from 'node:path'

/**
 * Absolute path to `packages/runner/config/guardrails.defaults.json`.
 *
 * Resolution order:
 * 1. Adjacent to compiled `dist/src/guardrails/` → `../../../config/`
 * 2. Adjacent to source `src/guardrails/` → `../../config/`
 */
export function getBundledGuardrailsDefaultsPath(): string {
  const candidates = [
    path.resolve(__dirname, '../../../config/guardrails.defaults.json'),
    path.resolve(__dirname, '../../config/guardrails.defaults.json'),
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return candidates[0]
}
