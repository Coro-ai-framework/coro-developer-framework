import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { proposeChange, listProposals } from '../../src/tools/self-improvement'
import { JobType, emptyTokenUsage, type Job } from '../../src/jobs/types'
import type { ToolContext } from '../../src/tools/types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('fs/promises')

const mockFs = vi.mocked(fs)

const A5AI_DIR = '/data/a5-ai'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'test-job-1',
    type: JobType.Migration,
    workflowPath: 'workflows/migration/workflow.md',
    params: { serviceName: 'my-svc' },
    triggerSource: 'cli',
    status: 'coding',
    phase: 'coding',
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

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    job: makeJob(),
    stateBackend: {
      appendLog: vi.fn().mockResolvedValue(undefined),
    } as unknown as ToolContext['stateBackend'],
    settings: {
      paths: { a5aiDir: A5AI_DIR, workingDir: '/data/working' },
    } as unknown as ToolContext['settings'],
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ToolContext['logger'],
    gitClient: {} as ToolContext['gitClient'],
    bbCoder: {} as ToolContext['bbCoder'],
    bbReviewer: {} as ToolContext['bbReviewer'],
    lokiClient: {} as ToolContext['lokiClient'],
    tempoClient: {} as ToolContext['tempoClient'],
    jiraClient: {} as ToolContext['jiraClient'],
    runningServices: new Map(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFs.mkdir.mockResolvedValue(undefined)
  mockFs.writeFile.mockResolvedValue(undefined)
})

// ── proposeChange ─────────────────────────────────────────────────────────────

describe('proposeChange', () => {
  describe('file writing', () => {
    it('writes a proposal summary to memory/proposals/', async () => {
      const ctx = makeCtx()
      await proposeChange({
        type: 'new-tool',
        title: 'Add foozle tool',
        rationale: 'We need foozle.',
        description: 'Adds a foozle tool.',
        files: [{ path: 'tools/src/tools/foozle.ts', content: 'export const x = 1' }],
      }, ctx)

      const writeCalls = mockFs.writeFile.mock.calls
      const proposalCall = writeCalls.find(c =>
        String(c[0]).includes('memory/proposals/') && String(c[0]).endsWith('.md'),
      )
      expect(proposalCall).toBeDefined()

      const proposalContent = proposalCall![1] as string
      expect(proposalContent).toContain('# Proposal: Add foozle tool')
      expect(proposalContent).toContain('**Type:** new-tool')
      expect(proposalContent).toContain('We need foozle.')
      expect(proposalContent).toContain('Adds a foozle tool.')
    })

    it('writes each proposed file to disk', async () => {
      await proposeChange({
        type: 'new-tool',
        title: 'Multi file',
        rationale: 'r',
        description: 'd',
        files: [
          { path: 'agents/new-agent.md', content: '# New Agent' },
          { path: 'memory/patterns.md', content: '# Patterns' },
        ],
      }, makeCtx())

      const writePaths = mockFs.writeFile.mock.calls.map(c => String(c[0]))
      expect(writePaths).toContainEqual(path.resolve(A5AI_DIR, 'agents/new-agent.md'))
      expect(writePaths).toContainEqual(path.resolve(A5AI_DIR, 'memory/patterns.md'))
    })

    it('creates directories recursively for each file', async () => {
      await proposeChange({
        type: 'new-tool',
        title: 'Deep file',
        rationale: 'r',
        description: 'd',
        files: [{ path: 'tools/src/deep/nested/file.ts', content: 'code' }],
      }, makeCtx())

      const mkdirCalls = mockFs.mkdir.mock.calls.map(c => String(c[0]))
      expect(mkdirCalls).toContainEqual(
        path.dirname(path.resolve(A5AI_DIR, 'tools/src/deep/nested/file.ts')),
      )
    })
  })

  describe('legacy single-file input', () => {
    it('handles targetFile + proposedContent', async () => {
      await proposeChange({
        type: 'modify-agent',
        title: 'Update coder',
        rationale: 'r',
        description: 'd',
        targetFile: 'agents/coder.md',
        proposedContent: '# Updated Coder',
      }, makeCtx())

      const writePaths = mockFs.writeFile.mock.calls.map(c => String(c[0]))
      expect(writePaths).toContainEqual(path.resolve(A5AI_DIR, 'agents/coder.md'))
    })

    it('merges legacy and multi-file inputs', async () => {
      const result = await proposeChange({
        type: 'new-tool',
        title: 'Both',
        rationale: 'r',
        description: 'd',
        targetFile: 'legacy.md',
        proposedContent: 'legacy content',
        files: [{ path: 'modern.md', content: 'modern content' }],
      }, makeCtx()) as Record<string, unknown>

      expect(result['fileCount']).toBe(2)
    })
  })

  describe('path traversal prevention', () => {
    it('throws when a file path escapes a5aiDir using ../', async () => {
      await expect(
        proposeChange({
          type: 'source-change',
          title: 'Escape attempt',
          rationale: 'r',
          description: 'd',
          files: [{ path: '../../../etc/passwd', content: 'malicious' }],
        }, makeCtx()),
      ).rejects.toThrow('escapes a5aiDir')
    })

    it('throws for absolute paths outside a5aiDir', async () => {
      await expect(
        proposeChange({
          type: 'source-change',
          title: 'Absolute escape',
          rationale: 'r',
          description: 'd',
          files: [{ path: '/etc/passwd', content: 'malicious' }],
        }, makeCtx()),
      ).rejects.toThrow('escapes a5aiDir')
    })
  })

  describe('return value', () => {
    it('returns expected structure', async () => {
      const result = await proposeChange({
        type: 'new-agent',
        title: 'Add optimizer agent',
        rationale: 'Performance improvements.',
        description: 'New optimizer.',
        files: [{ path: 'agents/optimizer.md', content: '# Optimizer' }],
      }, makeCtx()) as Record<string, unknown>

      expect(result['fileCount']).toBe(1)
      expect(result['filesWritten']).toHaveLength(2) // proposal + 1 file
      expect(result['nextStep']).toContain('File watcher')
      expect(typeof result['proposalFile']).toBe('string')
    })

    it('returns fileCount 0 when no files provided', async () => {
      const result = await proposeChange({
        type: 'memory-update',
        title: 'Note only',
        rationale: 'Just a note.',
        description: 'No files.',
      }, makeCtx()) as Record<string, unknown>

      expect(result['fileCount']).toBe(0)
    })
  })

  describe('logging', () => {
    it('appends to job log', async () => {
      const ctx = makeCtx()
      await proposeChange({
        type: 'new-tool',
        title: 'Test proposal',
        rationale: 'r',
        description: 'd',
      }, ctx)

      expect(ctx.stateBackend.appendLog).toHaveBeenCalledWith(
        'test-job-1',
        expect.stringContaining('[propose_change]'),
      )
    })
  })

  describe('proposal markdown content', () => {
    it('includes file content in proposal summary', async () => {
      await proposeChange({
        type: 'new-tool',
        title: 'With code',
        rationale: 'r',
        description: 'd',
        files: [{ path: 'tools/src/foo.ts', content: 'export const foo = 42' }],
      }, makeCtx())

      const proposalCall = mockFs.writeFile.mock.calls.find(c =>
        String(c[0]).includes('memory/proposals/'),
      )
      const content = proposalCall![1] as string
      expect(content).toContain('```ts')
      expect(content).toContain('export const foo = 42')
    })

    it('truncates large file content at 5000 chars', async () => {
      const bigContent = 'x'.repeat(6000)
      await proposeChange({
        type: 'source-change',
        title: 'Big file',
        rationale: 'r',
        description: 'd',
        files: [{ path: 'tools/src/big.ts', content: bigContent }],
      }, makeCtx())

      const proposalCall = mockFs.writeFile.mock.calls.find(c =>
        String(c[0]).includes('memory/proposals/'),
      )
      const md = proposalCall![1] as string
      expect(md).toContain('... (truncated in proposal summary)')
      expect(md.length).toBeLessThan(bigContent.length)
    })

    it('includes job context in proposal markdown', async () => {
      const ctx = makeCtx({ job: makeJob({ id: 'special-job', phase: 'testing' }) })
      await proposeChange({
        type: 'memory-update',
        title: 'Job info check',
        rationale: 'r',
        description: 'd',
      }, ctx)

      const proposalCall = mockFs.writeFile.mock.calls.find(c =>
        String(c[0]).includes('memory/proposals/'),
      )
      const md = proposalCall![1] as string
      expect(md).toContain('special-job')
      expect(md).toContain('testing')
    })
  })

  describe('slug generation', () => {
    it('converts title to URL-safe slug', async () => {
      await proposeChange({
        type: 'new-tool',
        title: 'Add Foo-Bar Tool (v2)',
        rationale: 'r',
        description: 'd',
      }, makeCtx())

      const proposalPath = String(mockFs.writeFile.mock.calls[0][0])
      expect(proposalPath).toMatch(/add-foo-bar-tool-v2\.md$/)
    })

    it('truncates long slugs to 60 chars', async () => {
      await proposeChange({
        type: 'new-tool',
        title: 'A'.repeat(100),
        rationale: 'r',
        description: 'd',
      }, makeCtx())

      const proposalPath = String(mockFs.writeFile.mock.calls[0][0])
      const filename = path.basename(proposalPath, '.md')
      // date prefix is 10 chars + dash = 11
      const slug = filename.slice(11)
      expect(slug.length).toBeLessThanOrEqual(60)
    })
  })
})

// ── listProposals ─────────────────────────────────────────────────────────────

describe('listProposals', () => {
  describe('when proposals directory exists', () => {
    it('returns proposals sorted newest first', async () => {
      mockFs.readdir.mockResolvedValue([
        '2026-03-01-old.md',
        '2026-04-01-new.md',
        '2026-03-15-mid.md',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

      mockFs.readFile.mockImplementation(async (p) => {
        const name = path.basename(String(p))
        return `# Proposal: ${name}\n\n**Type:** new-tool\n**Date:** 2026-01-01\n**Proposed by job:** j1\n\n## Rationale\n\nSome reason.`
      })

      const result = await listProposals({}, makeCtx()) as Record<string, unknown>
      const proposals = result['proposals'] as Array<Record<string, unknown>>

      expect(proposals).toHaveLength(3)
      expect(proposals[0]['filename']).toBe('2026-04-01-new.md')
      expect(proposals[2]['filename']).toBe('2026-03-01-old.md')
    })

    it('filters non-md files', async () => {
      mockFs.readdir.mockResolvedValue([
        '2026-04-01-real.md',
        'readme.txt',
        '.gitkeep',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

      mockFs.readFile.mockResolvedValue('# Proposal: Real\n\n**Type:** new-tool')

      const result = await listProposals({}, makeCtx()) as Record<string, unknown>
      expect((result['proposals'] as unknown[]).length).toBe(1)
    })

    it('respects the limit parameter', async () => {
      mockFs.readdir.mockResolvedValue([
        '2026-04-03-c.md',
        '2026-04-02-b.md',
        '2026-04-01-a.md',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

      mockFs.readFile.mockResolvedValue('# Proposal: X\n\n**Type:** new-tool')

      const result = await listProposals({ limit: 2 }, makeCtx()) as Record<string, unknown>
      expect((result['proposals'] as unknown[]).length).toBe(2)
    })

    it('filters by type when provided', async () => {
      mockFs.readdir.mockResolvedValue([
        '2026-04-01-new-tool-foozle.md',
        '2026-04-01-new-agent-optimizer.md',
        '2026-04-01-memory-update.md',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

      mockFs.readFile.mockResolvedValue('# Proposal: X\n\n**Type:** new-tool')

      const result = await listProposals({ type: 'new-agent' }, makeCtx()) as Record<string, unknown>
      const proposals = result['proposals'] as Array<Record<string, unknown>>
      expect(proposals).toHaveLength(1)
      expect(proposals[0]['filename']).toContain('new-agent')
    })

    it('extracts structured metadata from proposal markdown', async () => {
      mockFs.readdir.mockResolvedValue([
        '2026-04-01-test.md',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

      mockFs.readFile.mockResolvedValue(
        '# Proposal: Add rate limiter\n\n' +
        '**Type:** new-tool\n' +
        '**Date:** 2026-04-01T10:00:00Z\n' +
        '**Proposed by job:** my-job-123 (migration, phase: coding)\n' +
        '**Files:** 2\n\n' +
        '## Rationale\n\n' +
        'The system needs rate limiting to prevent abuse.\n\n' +
        '## Description\n\n' +
        'Implementation details.',
      )

      const result = await listProposals({}, makeCtx()) as Record<string, unknown>
      const p = (result['proposals'] as Array<Record<string, unknown>>)[0]

      expect(p['title']).toBe('Add rate limiter')
      expect(p['type']).toBe('new-tool')
      expect(p['date']).toBe('2026-04-01T10:00:00Z')
      expect(p['proposedBy']).toBe('my-job-123 (migration, phase: coding)')
      expect(p['isBuildFailure']).toBe(false)
      expect(p['preview']).toContain('rate limiting')
    })

    it('detects build failure proposals', async () => {
      mockFs.readdir.mockResolvedValue([
        '2026-04-01-build-failure-xyz.md',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

      mockFs.readFile.mockResolvedValue('# Build failure report\n\n## Compiler output\n\nTS2304: cannot find name.')

      const result = await listProposals({}, makeCtx()) as Record<string, unknown>
      const p = (result['proposals'] as Array<Record<string, unknown>>)[0]
      expect(p['isBuildFailure']).toBe(true)
      expect(p['preview']).toContain('TS2304')
    })

    it('returns totalOnDisk count matching all md files', async () => {
      mockFs.readdir.mockResolvedValue([
        '2026-04-03-c.md',
        '2026-04-02-b.md',
        '2026-04-01-a.md',
      ] as unknown as Awaited<ReturnType<typeof fs.readdir>>)

      mockFs.readFile.mockResolvedValue('# Proposal: X')

      const result = await listProposals({ limit: 1 }, makeCtx()) as Record<string, unknown>
      expect(result['count']).toBe(1)
      expect(result['totalOnDisk']).toBe(3)
    })
  })

  describe('when proposals directory does not exist', () => {
    it('returns empty result with message', async () => {
      mockFs.readdir.mockRejectedValue(new Error('ENOENT'))

      const result = await listProposals({}, makeCtx()) as Record<string, unknown>
      expect(result['proposals']).toEqual([])
      expect(result['count']).toBe(0)
      expect(result['message']).toContain('No proposals directory')
    })
  })

  describe('defaults', () => {
    it('defaults limit to 20', async () => {
      const files = Array.from({ length: 25 }, (_, i) =>
        `2026-01-${String(i + 1).padStart(2, '0')}-p.md`,
      )
      mockFs.readdir.mockResolvedValue(files as unknown as Awaited<ReturnType<typeof fs.readdir>>)
      mockFs.readFile.mockResolvedValue('# Proposal: X')

      const result = await listProposals({}, makeCtx()) as Record<string, unknown>
      expect((result['proposals'] as unknown[]).length).toBe(20)
    })
  })
})
