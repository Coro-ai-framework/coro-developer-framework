import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, it, expect } from 'vitest'

import {
  BASE_LAYER_NAME,
  BASE_LAYER_VERSION,
  LAYER_FILES,
  getBaseLayerRoot,
  pathInBaseLayer,
} from '../src'

describe('@coro-ai/intelligence-base manifest', () => {
  it('exports a sensible name + semver-ish version', () => {
    expect(BASE_LAYER_NAME).toBe('@coro-ai/intelligence-base')
    expect(BASE_LAYER_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  describe('getBaseLayerRoot', () => {
    const layerRoot = getBaseLayerRoot()

    it('returns an absolute path', () => {
      expect(path.isAbsolute(layerRoot)).toBe(true)
    })

    it('points at an existing directory', () => {
      expect(fs.existsSync(layerRoot)).toBe(true)
      expect(fs.statSync(layerRoot).isDirectory()).toBe(true)
    })

    it('contains the expected base intelligence layout', () => {
      const expected = [
        '.claude',
        '.claude/CLAUDE.md',
        '.claude/skills',
        'agents',
        'workflows',
        'memory',
        'memory/MEMORY.md',
      ]
      for (const rel of expected) {
        expect(fs.existsSync(path.join(layerRoot, rel)), `expected ${rel} to exist in base layer`).toBe(true)
      }
    })

    it('ships the canonical agent role definitions', () => {
      const agents = fs
        .readdirSync(path.join(layerRoot, 'agents'))
        .filter((f) => f.endsWith('.md'))
        .sort()
      expect(agents).toEqual([
        'analyzer.md',
        'campaign-architect.md',
        'campaign-evaluator.md',
        'campaign-integrator.md',
        'campaign-planner.md',
        'code-reviewer.md',
        'coder.md',
        'evaluator.md',
        'memory-curator.md',
        'planner.md',
        'pr-reviewer.md',
        'qa.md',
        'spec-writer.md',
      ])
    })

    it('ships the canonical workflows', () => {
      const workflows = fs
        .readdirSync(path.join(layerRoot, 'workflows'), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
      expect(workflows).toEqual(expect.arrayContaining(['job', 'self-update']))
      expect(fs.existsSync(path.join(layerRoot, 'workflows/job/workflow.md'))).toBe(true)
      expect(fs.existsSync(path.join(layerRoot, 'workflows/self-update/workflow.md'))).toBe(true)
    })

    it('ships the bundled skills', () => {
      const skills = fs
        .readdirSync(path.join(layerRoot, '.claude/skills'), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
      expect(skills).toEqual([
        'api-design',
        'campaign-contracts',
        'campaign-planning',
        'ci-cd-authoring',
        'cross-cutting-review',
        'db-migrations-safe',
        'dependency-hygiene',
        'dotnet-conventions',
        'feature-planning',
        'feature-testing',
        'feature-testing-contract',
        'feature-testing-e2e',
        'feature-testing-integration',
        'feature-testing-unit',
        'golang-conventions',
        'java-conventions',
        'kotlin-conventions',
        'observability-additions',
        'python-conventions',
        'register-convention',
        'ruby-conventions',
        'rust-conventions',
        'self-improvement-guide',
        'spec-quality',
        'typescript-conventions',
      ])
      for (const skill of skills) {
        expect(
          fs.existsSync(path.join(layerRoot, '.claude/skills', skill, 'SKILL.md')),
          `expected ${skill}/SKILL.md to exist`,
        ).toBe(true)
      }
    })
  })

  describe('layer is fully de-branded', () => {
    const layerRoot = getBaseLayerRoot()

    function readAllMd(dir: string): string[] {
      const out: string[] = []
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...readAllMd(full))
        else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
      }
      return out
    }

    it('contains no A5/a5-labs identifiers anywhere in the layer', () => {
      const offenders: string[] = []
      const banned = [/\bA5 Labs\b/, /\bA5Labs\./, /@a5-[a-z-]+/, /mcp__a5__/, /\ba5-ai\b/]
      for (const file of readAllMd(layerRoot)) {
        const body = fs.readFileSync(file, 'utf8')
        for (const pat of banned) {
          if (pat.test(body)) {
            offenders.push(`${path.relative(layerRoot, file)}: matched ${pat}`)
            break
          }
        }
      }
      expect(offenders, `de-brand violations:\n${offenders.join('\n')}`).toEqual([])
    })

    it('uses the mcp__coro__ prefix in agent docs', () => {
      const coder = fs.readFileSync(path.join(layerRoot, 'agents/coder.md'), 'utf8')
      expect(coder).toMatch(/mcp__coro__/)
    })
  })

  describe('pathInBaseLayer', () => {
    it('returns absolute paths to known files', () => {
      const claudeMd = pathInBaseLayer('claudeMd')
      expect(path.isAbsolute(claudeMd)).toBe(true)
      expect(claudeMd.endsWith(LAYER_FILES.claudeMd)).toBe(true)
      expect(fs.existsSync(claudeMd)).toBe(true)
    })

    it('covers every key in LAYER_FILES', () => {
      for (const key of Object.keys(LAYER_FILES) as Array<keyof typeof LAYER_FILES>) {
        const p = pathInBaseLayer(key)
        expect(fs.existsSync(p), `expected ${key} (${p}) to exist on disk`).toBe(true)
      }
    })
  })
})
