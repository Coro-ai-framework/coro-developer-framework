import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs/promises'
import { buildSystemPrompt } from '../../src/prompt/builder'
import { JobType, emptyTokenUsage, type Job } from '../../src/jobs/types'
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
    insights: [],
    tokenUsage: emptyTokenUsage(),
    phaseUsage: [],
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
    it('does not load CLAUDE.md (natively loaded by SDK via settingSources)', async () => {
      setupFs({
        '/data/a5-ai/CLAUDE.md': '# Root instructions — should NOT appear',
        '/data/a5-ai/workflows/migration/workflow.md': '',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).not.toContain('# Root instructions — should NOT appear')
    })

    it('includes workflow content with front matter stripped', async () => {
      const workflow = '---\ninitial_phase: analysis\nphases:\n  - name: analysis\n    agent: agents/analyzer.md\n    model: planning\n---\n\n# Migration Workflow\n\nThis is the workflow.'
      setupFs({
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
        '/data/a5-ai/workflows/migration/workflow.md': workflow,
        '/data/a5-ai/agents/analyzer.md': '# Analyzer\n\nStep 1: Analyze endpoints.',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('# Analyzer')
      expect(prompt).toContain('Step 1: Analyze endpoints.')
      expect(prompt).toContain('Your Role This Phase')
    })

    it('does not inject conventions (now on-demand via skills)', async () => {
      const workflow = '---\nphases:\n  - name: analysis\n    agent: agents/analyzer.md\n    model: planning\n    conventions: [auto]\n---\n\n# Workflow'
      setupFs({
        '/data/a5-ai/workflows/migration/workflow.md': workflow,
        '/data/a5-ai/agents/analyzer.md': '# Analyzer',
      })

      const job = makeJob({ params: { serviceName: 'my-svc', language: 'golang' } })
      const prompt = await buildSystemPrompt(job, makeSettings(), mockGitClient, noopLogger)
      expect(prompt).not.toContain('Conventions')
    })

    it('does not inject knowledge modules (now on-demand via skills)', async () => {
      const workflow = '---\nphases:\n  - name: analysis\n    agent: agents/analyzer.md\n    model: planning\n    knowledge: [knowledge/migration/analysis-guide.md]\n---\n\n# Workflow'
      setupFs({
        '/data/a5-ai/workflows/migration/workflow.md': workflow,
        '/data/a5-ai/agents/analyzer.md': '# Analyzer',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).not.toContain('Domain Knowledge')
    })

    it('does not inject infrastructure context (now in .claude/CLAUDE.md)', async () => {
      setupFs({
        '/data/a5-ai/workflows/migration/workflow.md': '',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).not.toContain('# Infrastructure')
      expect(prompt).not.toContain('BB_WORKSPACE')
    })

    it('always includes job context as the last section', async () => {
      setupFs({
        '/data/a5-ai/workflows/migration/workflow.md': '---\nphases:\n  - name: analysis\n    agent: agents/analyzer.md\n    model: planning\n---\n\n# Migration Workflow',
        '/data/a5-ai/agents/analyzer.md': '# Analyzer Agent',
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
        '/data/a5-ai/workflows/migration/workflow.md': '',
        '/data/a5-ai/memory/MEMORY.md': '- [Docs](https://example.com)\n- [Local](local.md)',
        '/data/a5-ai/memory/local.md': 'Local content',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('Local content')
      const readCalls = mockFs.readFile.mock.calls.map(c => String(c[0]))
      expect(readCalls.every(c => !c.includes('https://'))).toBe(true)
    })

    it('skips anchor links in memory index', async () => {
      setupFs({
        '/data/a5-ai/workflows/migration/workflow.md': '',
        '/data/a5-ai/memory/MEMORY.md': '- [Section](#pitfalls)',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('# Current Job')
    })

    it('includes pending proposals when proposals directory exists', async () => {
      setupFs({
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
        '/data/a5-ai/workflows/migration/workflow.md': '',
        '/data/a5-ai/memory/MEMORY.md': '# Memory Index',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).not.toContain('Pending Proposals')
      expect(prompt).toContain('# Current Job')
    })
  })

  describe('resilience', () => {
    it('continues when workflow file is missing', async () => {
      setupFs({})

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('# Current Job')
    })

    it('continues when agent file is missing', async () => {
      const workflow = '---\nphases:\n  - name: analysis\n    agent: agents/missing.md\n    model: planning\n---\n\n# Workflow'
      setupFs({
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
        '/data/a5-ai/workflows/migration/workflow.md': '',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).toContain('# Current Job')
      expect(noopLogger.warn).toHaveBeenCalled()
    })

    it('does not load agent when workflow has no front matter', async () => {
      setupFs({
        '/data/a5-ai/workflows/migration/workflow.md': '# Just a plain markdown file\n\nNo YAML here.',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).not.toContain('Your Role This Phase')
    })

    it('does not load agent when current phase has no agent', async () => {
      const workflow = '---\nphases:\n  - name: analysis\n    agent: ~\n    model: planning\n---\n\n# Workflow'
      setupFs({
        '/data/a5-ai/workflows/migration/workflow.md': workflow,
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(prompt).not.toContain('Your Role This Phase')
    })
  })

  describe('section ordering', () => {
    it('places sections in correct order: workflow, agent, memory, job', async () => {
      const workflow = '---\nphases:\n  - name: analysis\n    agent: agents/analyzer.md\n    model: planning\n---\n\n# Workflow Content'
      setupFs({
        '/data/a5-ai/workflows/migration/workflow.md': workflow,
        '/data/a5-ai/agents/analyzer.md': '# Analyzer Agent',
        '/data/a5-ai/memory/MEMORY.md': '# Memory Index',
      })

      const prompt = await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)

      const workflowIdx = prompt.indexOf('# Workflow Content')
      const agentIdx = prompt.indexOf('# Analyzer Agent')
      const memoryIdx = prompt.indexOf('# Memory Index')
      const jobIdx = prompt.indexOf('# Current Job')

      expect(workflowIdx).toBeLessThan(agentIdx)
      expect(agentIdx).toBeLessThan(memoryIdx)
      expect(memoryIdx).toBeLessThan(jobIdx)
    })
  })

  describe('git pull', () => {
    it('pulls the a5-ai repo before building the prompt', async () => {
      setupFs({
        '/data/a5-ai/workflows/migration/workflow.md': '',
      })

      await buildSystemPrompt(makeJob(), makeSettings(), mockGitClient, noopLogger)
      expect(mockGitClient.pull).toHaveBeenCalledWith('/data/a5-ai')
    })
  })
})
