import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs/promises'
import { buildSystemPrompt } from '../../src/prompt/builder'
import { JobType, type Job } from '../../src/jobs/types'
import type { GitClient } from '../../src/clients/git'
import type { Settings } from '../../src/config/settings'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('fs/promises')

const mockFs = vi.mocked(fs)

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'test-job-1',
    type: JobType.Migration,
    workflowPath: 'workflows/migration/workflow.md',
    params: { serviceName: 'my-svc', repoSlug: 'my-svc', reviewers: ['alice'] },
    triggerSource: 'cli',
    status: 'analyzing',
    phase: 'analysis',
    currentFeature: null,
    features: [],
    featureLoopCount: 0,
    prMappings: [],
    createdAt: '2026-04-04T00:00:00Z',
    updatedAt: '2026-04-04T00:00:00Z',
    ...overrides,
  }
}

function makeSettings(a5aiDir = '/data/a5-ai'): Settings {
  return {
    host: { port: 3000, webhookSecret: 'secret', logLevel: 'silent' },
    claude: { apiKey: 'key', planningModel: 'claude-opus-4-6', codingModel: 'claude-sonnet-4-6' },
    bitbucket: {
      workspace: 'ws', baseUrl: 'https://api.bitbucket.org/2.0',
      coderAccount: { username: 'coder', appPassword: 'pass' },
      reviewerAccount: { username: 'reviewer', appPassword: 'pass' },
    },
    redis: { url: 'redis://localhost' },
    paths: { workingDir: '/data/working', a5aiDir },
    loki: { baseUrl: '', apiKey: '', username: '' },
    tempo: { baseUrl: '', apiKey: '' },
    jira: { baseUrl: '', username: '', apiToken: '', pollIntervalSeconds: 60 },
    ngrok: { authToken: '', staticDomain: '' },
  }
}

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as import('pino').Logger

const mockGitClient = {
  pull: vi.fn().mockResolvedValue(undefined),
} as unknown as GitClient

// ── File system fixture helper ────────────────────────────────────────────────

type FileMap = Record<string, string>

function setupFs(files: FileMap): void {
  mockFs.readFile.mockImplementation(async (p: Parameters<typeof fs.readFile>[0]) => {
    const pathStr = typeof p === 'string' ? p : p.toString()
    const content = files[pathStr]
    if (content !== undefined) return content
    throw new Error(`ENOENT: no such file: ${pathStr}`)
  })

  mockFs.readdir.mockImplementation(async (p: Parameters<typeof fs.readdir>[0]) => {
    const dirStr = typeof p === 'string' ? p : p.toString()
    const entries: string[] = []
    for (const key of Object.keys(files)) {
      if (key.startsWith(dirStr + '/')) {
        const rest = key.slice(dirStr.length + 1)
        if (!rest.includes('/')) entries.push(rest)
      }
    }
    if (entries.length === 0 && !Object.keys(files).some(k => k.startsWith(dirStr))) {
      throw new Error(`ENOENT: no such directory: ${dirStr}`)
    }
    return entries as unknown as ReturnType<typeof fs.readdir>
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildSystemPrompt', () => {
  describe('section assembly', () => {
    it('includes CLAUDE.md when present', async () => {
      setupFs({
        '/data/a5-ai/CLAUDE.md': '# Root instructions',
        '/data/a5-ai/workflows/migration/workflow.md': '',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('# Root instructions')
    })

    it('includes workflow content with front matter stripped', async () => {
      const workflow = '---\ninitial_phase: analysis\nphases:\n  - name: analysis\n    agent: agents/analyzer.md\n    model: planning\n---\n\n# Migration Workflow\n\nThis is the workflow.'
      setupFs({
        '/data/a5-ai/CLAUDE.md': '# Root',
        '/data/a5-ai/workflows/migration/workflow.md': workflow,
        '/data/a5-ai/agents/analyzer.md': '# Analyzer Agent\n\nAnalyze things.',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('# Migration Workflow')
      expect(prompt).toContain('This is the workflow.')
      expect(prompt).not.toContain('initial_phase: analysis')
    })

    it('includes agent instructions for the current phase', async () => {
      const workflow = '---\nphases:\n  - name: analysis\n    agent: agents/analyzer.md\n    model: planning\n---\n\n# Workflow'
      setupFs({
        '/data/a5-ai/CLAUDE.md': '# Root',
        '/data/a5-ai/workflows/migration/workflow.md': workflow,
        '/data/a5-ai/agents/analyzer.md': '# Analyzer\n\nStep 1: Analyze endpoints.',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('# Analyzer')
      expect(prompt).toContain('Step 1: Analyze endpoints.')
      expect(prompt).toContain('Your Role This Phase')
    })

    it('includes git conventions by default (no language hardcoded)', async () => {
      setupFs({
        '/data/a5-ai/CLAUDE.md': '# Root',
        '/data/a5-ai/workflows/migration/workflow.md': '',
        '/data/a5-ai/conventions/git.md': '# Git Conventions\n\nUse conventional commits.',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('Use conventional commits.')
    })

    it('loads language conventions via auto when job.params.language is set', async () => {
      const workflow = '---\nphases:\n  - name: analysis\n    agent: agents/analyzer.md\n    model: planning\n    conventions: [auto]\n---\n\n# Workflow'
      setupFs({
        '/data/a5-ai/CLAUDE.md': '# Root',
        '/data/a5-ai/workflows/migration/workflow.md': workflow,
        '/data/a5-ai/agents/analyzer.md': '# Analyzer',
        '/data/a5-ai/conventions/git.md': '# Git Conv',
        '/data/a5-ai/conventions/golang.md': '# Go Conventions\n\nUse chi router.',
      })

      const job = makeJob({ params: { serviceName: 'my-svc', language: 'golang' } })
      const prompt = await buildSystemPrompt(job, makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('Use chi router.')
      expect(prompt).toContain('# Git Conv')
    })

    it('does not load language conventions when conventions field is absent', async () => {
      const workflow = '---\nphases:\n  - name: analysis\n    agent: agents/analyzer.md\n    model: planning\n---\n\n# Workflow'
      setupFs({
        '/data/a5-ai/CLAUDE.md': '# Root',
        '/data/a5-ai/workflows/migration/workflow.md': workflow,
        '/data/a5-ai/agents/analyzer.md': '# Analyzer',
        '/data/a5-ai/conventions/git.md': '# Git Conv',
        '/data/a5-ai/conventions/golang.md': '# Go Conventions\n\nUse chi router.',
      })

      const job = makeJob({ params: { serviceName: 'my-svc', language: 'golang' } })
      const prompt = await buildSystemPrompt(job, makeSettings(), mockGitClient, noopLogger)
      expect(prompt).not.toContain('Use chi router.')
      expect(prompt).toContain('# Git Conv')
    })

    it('loads explicit convention paths from workflow YAML', async () => {
      const workflow = '---\nphases:\n  - name: analysis\n    agent: agents/analyzer.md\n    model: planning\n    conventions: [conventions/dotnet.md]\n---\n\n# Workflow'
      setupFs({
        '/data/a5-ai/CLAUDE.md': '# Root',
        '/data/a5-ai/workflows/migration/workflow.md': workflow,
        '/data/a5-ai/agents/analyzer.md': '# Analyzer',
        '/data/a5-ai/conventions/git.md': '# Git Conv',
        '/data/a5-ai/conventions/dotnet.md': '# .NET Conventions\n\nUse PascalCase.',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('Use PascalCase.')
      expect(prompt).toContain('# Git Conv')
    })

    it('loads knowledge modules when specified in workflow YAML', async () => {
      const workflow = '---\nphases:\n  - name: analysis\n    agent: agents/analyzer.md\n    model: planning\n    knowledge: [knowledge/migration/analysis-guide.md]\n---\n\n# Workflow'
      setupFs({
        '/data/a5-ai/CLAUDE.md': '# Root',
        '/data/a5-ai/workflows/migration/workflow.md': workflow,
        '/data/a5-ai/agents/analyzer.md': '# Analyzer',
        '/data/a5-ai/conventions/git.md': '# Git Conv',
        '/data/a5-ai/knowledge/migration/analysis-guide.md': '# Analysis Guide\n\nExtract controllers.',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('Extract controllers.')
      expect(prompt).toContain('Domain Knowledge')
    })

    it('always includes job context as the last section', async () => {
      setupFs({
        '/data/a5-ai/CLAUDE.md': '# Root',
        '/data/a5-ai/workflows/migration/workflow.md': '',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      const lastSectionStart = prompt.lastIndexOf('# Current Job')
      expect(lastSectionStart).toBeGreaterThan(0)
      expect(prompt.slice(lastSectionStart)).toContain('"test-job-1"')
    })
  })

  describe('job context', () => {
    it('includes all key job fields in JSON', async () => {
      setupFs({
        '/data/a5-ai/CLAUDE.md': '',
        '/data/a5-ai/workflows/migration/workflow.md': '',
      })

      const job = makeJob({
        awaitingEvent: 'pr:fulfilled',
        awaitingPrId: 42,
        escalationMessage: 'Something went wrong',
      })

      const prompt = await buildSystemPrompt(job, makeSettings(), mockGitClient, noopLogger)
      const jsonStart = prompt.indexOf('```json\n') + 8
      const jsonEnd = prompt.indexOf('\n```', jsonStart)
      const ctx = JSON.parse(prompt.slice(jsonStart, jsonEnd)) as Record<string, unknown>

      expect(ctx['jobId']).toBe('test-job-1')
      expect(ctx['type']).toBe('migration')
      expect(ctx['phase']).toBe('analysis')
      expect(ctx['status']).toBe('analyzing')
      expect(ctx['triggerSource']).toBe('cli')
      expect(ctx['awaitingEvent']).toBe('pr:fulfilled')
      expect(ctx['awaitingPrId']).toBe(42)
      expect(ctx['escalationMessage']).toBe('Something went wrong')
      expect(ctx['params']).toEqual({ serviceName: 'my-svc', repoSlug: 'my-svc', reviewers: ['alice'] })
    })

    it('nulls out optional fields when not set', async () => {
      setupFs({
        '/data/a5-ai/CLAUDE.md': '',
        '/data/a5-ai/workflows/migration/workflow.md': '',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      const jsonStart = prompt.indexOf('```json\n') + 8
      const jsonEnd = prompt.indexOf('\n```', jsonStart)
      const ctx = JSON.parse(prompt.slice(jsonStart, jsonEnd)) as Record<string, unknown>

      expect(ctx['awaitingEvent']).toBeNull()
      expect(ctx['awaitingPrId']).toBeNull()
      expect(ctx['escalationMessage']).toBeNull()
    })

    it('includes features and featureLoopCount in job context', async () => {
      setupFs({
        '/data/a5-ai/CLAUDE.md': '',
        '/data/a5-ai/workflows/migration/workflow.md': '',
      })

      const job = makeJob({
        features: [
          { name: 'scaffold', status: 'complete', loopCount: 1 },
          { name: 'users-api', status: 'in-progress', loopCount: 0 },
        ],
        featureLoopCount: 0,
        currentFeature: 'users-api',
      })

      const prompt = await buildSystemPrompt(job, makeSettings(), mockGitClient, noopLogger)
      const jsonStart = prompt.indexOf('```json\n') + 8
      const jsonEnd = prompt.indexOf('\n```', jsonStart)
      const ctx = JSON.parse(prompt.slice(jsonStart, jsonEnd)) as Record<string, unknown>

      expect(ctx['features']).toEqual([
        { name: 'scaffold', status: 'complete', loopCount: 1 },
        { name: 'users-api', status: 'in-progress', loopCount: 0 },
      ])
      expect(ctx['featureLoopCount']).toBe(0)
      expect(ctx['currentFeature']).toBe('users-api')
    })
  })

  describe('memory loading', () => {
    it('loads memory index and linked files', async () => {
      setupFs({
        '/data/a5-ai/CLAUDE.md': '',
        '/data/a5-ai/workflows/migration/workflow.md': '',
        '/data/a5-ai/memory/MEMORY.md': '# Memory\n\n- [Known pitfalls](known-pitfalls.md)\n- [Patterns](successful-patterns.md)',
        '/data/a5-ai/memory/known-pitfalls.md': '# Pitfalls\n\nDo not use X.',
        '/data/a5-ai/memory/successful-patterns.md': '# Patterns\n\nAlways use Y.',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('# Pitfalls')
      expect(prompt).toContain('Do not use X.')
      expect(prompt).toContain('# Patterns')
      expect(prompt).toContain('Always use Y.')
    })

    it('skips external URLs in memory index links', async () => {
      setupFs({
        '/data/a5-ai/CLAUDE.md': '',
        '/data/a5-ai/workflows/migration/workflow.md': '',
        '/data/a5-ai/memory/MEMORY.md': '- [Docs](https://example.com)\n- [Local](local.md)',
        '/data/a5-ai/memory/local.md': 'Local content',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('Local content')
      // Should not have tried to read https://example.com as a file
      const readCalls = mockFs.readFile.mock.calls.map(c => String(c[0]))
      expect(readCalls.every(c => !c.includes('https://'))).toBe(true)
    })

    it('skips anchor links in memory index', async () => {
      setupFs({
        '/data/a5-ai/CLAUDE.md': '',
        '/data/a5-ai/workflows/migration/workflow.md': '',
        '/data/a5-ai/memory/MEMORY.md': '- [Section](#pitfalls)',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      // Should not crash on anchor links
      expect(prompt).toContain('# Current Job')
    })

    it('includes pending proposals when proposals directory exists', async () => {
      setupFs({
        '/data/a5-ai/CLAUDE.md': '',
        '/data/a5-ai/workflows/migration/workflow.md': '',
        '/data/a5-ai/memory/MEMORY.md': '# Memory Index',
        '/data/a5-ai/memory/proposals/2026-04-01-add-tool.md': '# Proposal: Add tool\n\nRationale here.',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('Pending Proposals')
      expect(prompt).toContain('# Proposal: Add tool')
    })

    it('handles missing proposals directory gracefully', async () => {
      setupFs({
        '/data/a5-ai/CLAUDE.md': '',
        '/data/a5-ai/workflows/migration/workflow.md': '',
        '/data/a5-ai/memory/MEMORY.md': '# Memory Index',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).not.toContain('Pending Proposals')
      expect(prompt).toContain('# Current Job')
    })
  })

  describe('resilience', () => {
    it('continues when CLAUDE.md is missing', async () => {
      setupFs({
        '/data/a5-ai/workflows/migration/workflow.md': '',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('# Current Job')
    })

    it('continues when workflow file is missing', async () => {
      setupFs({
        '/data/a5-ai/CLAUDE.md': '# Root',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('# Root')
      expect(prompt).toContain('# Current Job')
    })

    it('continues when agent file is missing', async () => {
      const workflow = '---\nphases:\n  - name: analysis\n    agent: agents/missing.md\n    model: planning\n---\n\n# Workflow'
      setupFs({
        '/data/a5-ai/CLAUDE.md': '# Root',
        '/data/a5-ai/workflows/migration/workflow.md': workflow,
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).not.toContain('Your Role This Phase')
      expect(prompt).toContain('# Current Job')
    })

    it('continues when git pull fails', async () => {
      (mockGitClient.pull as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Network error'),
      )
      setupFs({
        '/data/a5-ai/CLAUDE.md': '# Root',
        '/data/a5-ai/workflows/migration/workflow.md': '',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('# Root')
      expect(noopLogger.warn).toHaveBeenCalled()
    })

    it('does not load agent when workflow has no front matter', async () => {
      setupFs({
        '/data/a5-ai/CLAUDE.md': '# Root',
        '/data/a5-ai/workflows/migration/workflow.md': '# Just a plain markdown file\n\nNo YAML here.',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).not.toContain('Your Role This Phase')
    })

    it('does not load agent when current phase has no agent', async () => {
      const workflow = '---\nphases:\n  - name: analysis\n    agent: ~\n    model: planning\n---\n\n# Workflow'
      setupFs({
        '/data/a5-ai/CLAUDE.md': '# Root',
        '/data/a5-ai/workflows/migration/workflow.md': workflow,
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).not.toContain('Your Role This Phase')
    })
  })

  describe('section ordering', () => {
    it('places sections in correct order: root, workflow, agent, memory, conventions, job', async () => {
      const workflow = '---\nphases:\n  - name: analysis\n    agent: agents/analyzer.md\n    model: planning\n    conventions: [auto]\n    knowledge: [knowledge/migration/analysis-guide.md]\n---\n\n# Workflow Content'
      setupFs({
        '/data/a5-ai/CLAUDE.md': '# CLAUDE Root',
        '/data/a5-ai/workflows/migration/workflow.md': workflow,
        '/data/a5-ai/agents/analyzer.md': '# Analyzer Agent',
        '/data/a5-ai/memory/MEMORY.md': '# Memory Index',
        '/data/a5-ai/conventions/git.md': '# Git Conv',
        '/data/a5-ai/conventions/golang.md': '# Go Conv',
        '/data/a5-ai/knowledge/migration/analysis-guide.md': '# Analysis Knowledge',
      })

      const job = makeJob({ params: { serviceName: 'my-svc', language: 'golang' } })
      const prompt = await buildSystemPrompt(job, makeSettings(), mockGitClient, noopLogger)

      const rootIdx = prompt.indexOf('# CLAUDE Root')
      const workflowIdx = prompt.indexOf('# Workflow Content')
      const agentIdx = prompt.indexOf('# Analyzer Agent')
      const memoryIdx = prompt.indexOf('# Memory Index')
      const gitIdx = prompt.indexOf('# Git Conv')
      const goIdx = prompt.indexOf('# Go Conv')
      const knowledgeIdx = prompt.indexOf('# Analysis Knowledge')
      const jobIdx = prompt.indexOf('# Current Job')

      expect(rootIdx).toBeLessThan(workflowIdx)
      expect(workflowIdx).toBeLessThan(agentIdx)
      expect(agentIdx).toBeLessThan(memoryIdx)
      expect(memoryIdx).toBeLessThan(gitIdx)
      expect(gitIdx).toBeLessThan(goIdx)
      expect(goIdx).toBeLessThan(knowledgeIdx)
      expect(knowledgeIdx).toBeLessThan(jobIdx)
    })
  })

  describe('git pull', () => {
    it('pulls the a5-ai repo before building the prompt', async () => {
      setupFs({
        '/data/a5-ai/CLAUDE.md': '',
        '/data/a5-ai/workflows/migration/workflow.md': '',
      })

      await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(mockGitClient.pull).toHaveBeenCalledWith('/data/a5-ai')
    })
  })
})
