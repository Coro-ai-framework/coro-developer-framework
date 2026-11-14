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
    const commandsDir = path.join(layerRoot, LAYER_FILES.workflowsDir)
    const commandSlugs = fs
      .readdirSync(commandsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort()

    it('returns an absolute path', () => {
      expect(path.isAbsolute(layerRoot)).toBe(true)
    })

    it('points at an existing directory', () => {
      expect(fs.existsSync(layerRoot)).toBe(true)
      expect(fs.statSync(layerRoot).isDirectory()).toBe(true)
    })

    it('contains the expected base intelligence layout', () => {
      const expected = [
        'AGENTS.md',
        '.claude',
        '.claude/CLAUDE.md',
        '.claude/coro/RUNTIME.md',
        '.claude/skills',
        '.claude/agents',
        '.claude/commands/coro',
        '.claude/memory',
        '.claude/memory/MEMORY.md',
      ]
      // The pre-native layout must be gone, not merely duplicated.
      for (const rel of ['agents', 'workflows', 'memory']) {
        expect(fs.existsSync(path.join(layerRoot, rel)), `${rel}/ moved under .claude/`).toBe(false)
      }
      for (const rel of expected) {
        expect(fs.existsSync(path.join(layerRoot, rel)), `expected ${rel} to exist in base layer`).toBe(true)
      }
    })

    it('ships the canonical agent role definitions', () => {
      const agents = fs
        .readdirSync(path.join(layerRoot, '.claude/agents'))
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
        'oss-coder.md',
        'oss-contributor.md',
        'oss-planner.md',
        'oss-verifier.md',
        'planner.md',
        'pr-review-converse.md',
        'pr-review-lead.md',
        'pr-review-learn.md',
        'pr-review-publish.md',
        'pr-reviewer.md',
        'qa.md',
        'retrospective-analyst.md',
        'review-architecture.md',
        'review-correctness.md',
        'review-design.md',
        'review-history.md',
        'review-security.md',
        'review-tests.md',
        'review-verifier.md',
        'spec-writer.md',
      ])
    })

    it('ships the canonical workflows as slash commands', () => {
      expect(commandSlugs).toEqual([
        'campaign',
        'job',
        'job-deep',
        'job-fast',
        'memory-curator',
        'oss-contribution',
        'pr-review',
        'retrospective',
        'self-update',
      ])
      for (const slug of commandSlugs) {
        expect(fs.existsSync(path.join(commandsDir, `${slug}.md`)), `${slug}.md`).toBe(true)
      }
    })

    it('ships the bundled skills', () => {
      const skills = fs
        .readdirSync(path.join(layerRoot, '.claude/skills'), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
      expect(skills).toEqual([
        'api-design',
        'architecture-review',
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
        'pr-review-guidelines',
        'pr-review-ledger',
        'python-conventions',
        'register-convention',
        'retrospective-analysis',
        'ruby-conventions',
        'rust-conventions',
        'sandbox-recovery',
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
      const coder = fs.readFileSync(path.join(layerRoot, '.claude/agents/coder.md'), 'utf8')
      expect(coder).toMatch(/mcp__coro__/)
    })
  })

  // The layer is a native Claude Code tree: copy `.claude/` and `AGENTS.md` into
  // a repository and Claude Code discovers the agents, skills and workflows
  // (slash commands) with no runner. These invariants are what makes that true.
  describe('layer is native to Claude Code', () => {
    const layerRoot = getBaseLayerRoot()
    const read = (rel: string): string => fs.readFileSync(path.join(layerRoot, rel), 'utf8')
    const ls = (rel: string): string[] =>
      fs.readdirSync(path.join(layerRoot, rel)).filter((f) => f.endsWith('.md')).sort()

    /** Front matter lines, or null. */
    function frontMatter(md: string): string[] | null {
      const m = /^---\n([\s\S]*?)\n---/.exec(md)
      return m ? m[1]!.split('\n') : null
    }
    function field(fm: string[], key: string): string | undefined {
      const line = fm.find((l) => l.startsWith(`${key}:`))
      return line?.slice(key.length + 1).trim().replace(/^"|"$/g, '')
    }
    /** Same rule the runner applies when it materialises a job's intelligence. */
    const strip = (md: string): string =>
      md.replace(
        /^[ \t]*<!-- standalone:start -->[ \t]*\r?\n[\s\S]*?^[ \t]*<!-- standalone:end -->[ \t]*(?:\r?\n)*/gm,
        '',
      )
    function standaloneBlocks(md: string): string[] {
      return [...md.matchAll(/^<!-- standalone:start -->$([\s\S]*?)^<!-- standalone:end -->$/gm)].map((m) => m[1]!)
    }
    function allMd(dir: string): string[] {
      const out: string[] = []
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...allMd(full))
        else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full)
      }
      return out
    }

    it('gives every agent a name equal to its file name and a description', () => {
      for (const file of ls('.claude/agents')) {
        const fm = frontMatter(read(`.claude/agents/${file}`))
        expect(fm, `${file} has front matter`).not.toBeNull()
        expect(field(fm!, 'name'), `${file} name`).toBe(file.replace(/\.md$/, ''))
        expect(field(fm!, 'description')?.length ?? 0, `${file} description`).toBeGreaterThan(20)
      }
    })

    it('restricts the read-only review lenses to read-only tools', () => {
      for (const file of ls('.claude/agents').filter((f) => f.startsWith('review-'))) {
        const fm = frontMatter(read(`.claude/agents/${file}`))!
        expect(field(fm, 'tools'), `${file} tools`).toBe('Read, Grep, Glob, Bash')
      }
    })

    it('keeps each agent title directly after the front matter', () => {
      for (const file of ls('.claude/agents')) {
        const body = read(`.claude/agents/${file}`).replace(/^---\n[\s\S]*?\n---\n/, '').trimStart()
        expect(body.startsWith('# '), `${file} starts with an H1`).toBe(true)
      }
    })

    it('gives every workflow command an argument hint, and every phase an agent that exists', () => {
      for (const file of ls('.claude/commands/coro')) {
        const md = read(`.claude/commands/coro/${file}`)
        const fm = frontMatter(md)
        expect(fm, `${file} has front matter`).not.toBeNull()
        expect(field(fm!, 'argument-hint'), `${file} argument-hint`).toBeTruthy()
        for (const line of fm!) {
          const m = /^\s+agent:\s*(\S+)\s*$/.exec(line)
          if (m && m[1] !== 'null') {
            expect(fs.existsSync(path.join(layerRoot, m[1]!)), `${file}: ${m[1]} exists`).toBe(true)
          }
        }
      }
    })

    it('keeps runner-only workflows out of the model\'s hands', () => {
      const runnerOnly = ['campaign', 'memory-curator', 'oss-contribution', 'pr-review', 'retrospective', 'self-update']
      for (const slug of runnerOnly) {
        const md = read(`.claude/commands/coro/${slug}.md`)
        expect(field(frontMatter(md)!, 'disable-model-invocation'), slug).toBe('true')
        expect(standaloneBlocks(md).join('\n'), `${slug} says it needs the runner`).toMatch(/needs the Coro runner/)
      }
    })

    it('names every phase agent in the standalone steps of the portable workflows', () => {
      for (const slug of ['job', 'job-fast', 'job-deep']) {
        const md = read(`.claude/commands/coro/${slug}.md`)
        const fm = frontMatter(md)!
        const block = standaloneBlocks(md).join('\n')
        expect(block, `${slug} has a standalone block`).toContain('$ARGUMENTS')
        const agents = fm
          .map((l) => /^\s+agent:\s*\.claude\/agents\/([\w-]+)\.md\s*$/.exec(l)?.[1])
          .filter((n): n is string => Boolean(n))
        expect(agents.length, `${slug} declares agents`).toBeGreaterThan(0)
        for (const agent of agents) {
          expect(block, `${slug} standalone steps name \`${agent}\``).toContain(`\`${agent}\``)
        }
      }
    })

    it('fences standalone blocks on their own lines, each start with an end', () => {
      for (const file of allMd(layerRoot)) {
        const md = fs.readFileSync(file, 'utf8')
        const starts = [...md.matchAll(/<!-- standalone:start -->/g)].length
        const ends = [...md.matchAll(/<!-- standalone:end -->/g)].length
        const rel = path.relative(layerRoot, file)
        expect(ends, `${rel}: unbalanced standalone markers`).toBe(starts)
        const ownLine = [...md.matchAll(/^<!-- standalone:(start|end) -->$/gm)].length
        expect(ownLine, `${rel}: every marker must be alone on its line`).toBe(starts + ends)
        expect(standaloneBlocks(md).length, `${rel}: a start must precede its end`).toBe(starts)
      }
    })

    it('leaves nothing of a standalone block behind once stripped', () => {
      for (const file of allMd(layerRoot)) {
        expect(strip(fs.readFileSync(file, 'utf8')), path.relative(layerRoot, file)).not.toMatch(/<!-- standalone:(start|end) -->/)
      }
    })

    it('keeps Coro-only tools out of the portable CLAUDE.md and in the runtime contract', () => {
      expect(strip(read(LAYER_FILES.claudeMd))).not.toMatch(/mcp__coro__/)
      expect(read(LAYER_FILES.runtimeMd)).toMatch(/mcp__coro__/)
      expect(read(LAYER_FILES.claudeMd)).toMatch(/Running without the Coro runner/)
    })

    it('points other agent tools at the right files from AGENTS.md', () => {
      const agentsMd = read(LAYER_FILES.agentsMd)
      for (const needle of ['.claude/CLAUDE.md', '.claude/skills', '.claude/agents', '.claude/commands/coro', '.claude/memory']) {
        expect(agentsMd, `AGENTS.md mentions ${needle}`).toContain(needle)
      }
      expect(agentsMd).not.toMatch(/<!-- standalone:(start|end) -->/)
    })

    it('contains no reference to the pre-native paths', () => {
      const stale: Array<[RegExp, string]> = [
        [/(?<![\w./-])agents\/[a-z][\w-]*\.md/, 'agents/<name>.md'],
        [/(?<![\w./-])workflows\/[\w-]+\/workflow\.md/, 'workflows/<id>/workflow.md'],
        [/(?<![\w./-])memory\/(MEMORY|known-pitfalls|successful-patterns|pr-feedback)/, 'memory/<file>'],
      ]
      const offenders: string[] = []
      for (const file of allMd(layerRoot)) {
        const md = fs.readFileSync(file, 'utf8')
        for (const [re, label] of stale) {
          if (re.test(md)) offenders.push(`${path.relative(layerRoot, file)}: ${label}`)
        }
      }
      expect(offenders, `stale paths:\n${offenders.join('\n')}`).toEqual([])
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
