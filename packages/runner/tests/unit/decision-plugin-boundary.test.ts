/**
 * The decision vendor adapter stays inside its plugin folder.
 * Runner core may import the provider id and default model, and may
 * dynamically load the plugin from the client factory. It must not
 * name the vendor host, and it must not statically import the HTTP client.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const RUNNER_ROOT = path.resolve(__dirname, '../../src')
const PLUGIN_DIR = path.normalize('plugins/builtin/jev/')
const FACTORY = path.normalize('clients/decision/index.ts')

function collectFiles(target: string): string[] {
  const stat = statSync(target)
  if (stat.isFile()) return target.endsWith('.ts') ? [target] : []
  const out: string[] = []
  for (const entry of readdirSync(target)) {
    out.push(...collectFiles(path.join(target, entry)))
  }
  return out
}

describe('decision plugin boundary', () => {
  it('names the vendor host only inside the jev plugin', () => {
    const offenders: string[] = []
    for (const file of collectFiles(RUNNER_ROOT)) {
      const rel = path.relative(RUNNER_ROOT, file)
      if (rel.startsWith(PLUGIN_DIR)) continue
      const src = readFileSync(file, 'utf-8')
      if (/typesafe/i.test(src)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('loads the jev HTTP client only from the decision client factory', () => {
    const offenders: string[] = []
    const dynamicRe = /import\(\s*['"][^'"]*plugins\/builtin\/jev['"]\s*\)/
    const staticRe = /from\s+['"][^'"]*plugins\/builtin\/jev(?:\/provider)?['"]/
    for (const file of collectFiles(RUNNER_ROOT)) {
      const rel = path.relative(RUNNER_ROOT, file)
      if (rel.startsWith(PLUGIN_DIR)) continue
      const src = readFileSync(file, 'utf-8')
      const dynamic = dynamicRe.test(src)
      const staticProvider = staticRe.test(src)
      if (path.normalize(rel) === FACTORY) {
        expect(dynamic, 'factory should dynamic-import the plugin').toBe(true)
        expect(staticProvider, 'factory should not statically import the HTTP client').toBe(false)
        continue
      }
      if (dynamic || staticProvider) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
})
