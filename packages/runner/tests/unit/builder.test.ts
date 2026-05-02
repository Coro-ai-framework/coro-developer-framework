import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs/promises'
import { buildSystemPrompt, computeTrackerPromptContext } from '../../src/prompt/builder'
import type { Settings } from '../../src/config/settings'
import type { TrackerClient, TrackerProvider } from '../../src/clients/tracker'
import { JobType, emptyTokenUsage, type Job } from '../../src/jobs/types'

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('fs/promises')

const mockFs = vi.mocked(fs)
const INTELLIGENCE_DIR = '/data/coro-intelligence'
const WORKFLOW_PATH = '/data/coro-intelligence/workflows/job/workflow.md'
const PLANNER_AGENT_PATH = '/data/coro-intelligence/agents/planner.md'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'test-job-1',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { serviceName: 'my-svc', repoSlug: 'my-svc', reviewers: ['alice'] },
    triggerSource: 'cli',
    status: 'planning',
    phase: 'planning',
    currentWorkItem: null,
    workItems: [],
    workItemLoopCount: 0,
    prMappings: [],
    interactive: false,
    artifacts: [],
    insights: [],
    tokenUsage: emptyTokenUsage(),
    phaseUsage: [],
    createdAt: '2026-04-04T00:00:00Z',
    updatedAt: '2026-04-04T00:00:00Z',
    ...overrides,
  }
}

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as import('pino').Logger

// ── File system fixture helper ────────────────────────────────────────────────

type FileMap = Record<string, string>

function setupFs(files: FileMap): void {
  mockFs.readFile.mockImplementation(async (p: Parameters<typeof fs.readFile>[0]) => {
    const pathStr = typeof p === 'string' ? p : p.toString()
    const content = files[pathStr]
    if (content !== undefined) return content
    throw new Error(`ENOENT: no such file: ${pathStr}`)
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildSystemPrompt (lean, on-demand context model)', () => {
  describe('section assembly', () => {
    it('does not load CLAUDE.md (natively loaded by SDK via settingSources)', async () => {
      setupFs({
        '/data/coro-intelligence/CLAUDE.md': '# Root instructions — should NOT appear',
        [WORKFLOW_PATH]: '',
      })

      const prompt = await buildSystemPrompt(makeJob(), INTELLIGENCE_DIR, noopLogger)
      expect(prompt).not.toContain('# Root instructions — should NOT appear')
    })

    it('includes workflow content with front matter stripped', async () => {
      const workflow = '---\ninitial_phase: planning\nphases:\n  - name: planning\n    agent: agents/planner.md\n    model: planning\n---\n\n# Job Workflow\n\nThis is the workflow.'
      setupFs({
        [WORKFLOW_PATH]: workflow,
        [PLANNER_AGENT_PATH]: '# Planner Agent\n\nPlan things.',
      })

      const prompt = await buildSystemPrompt(makeJob(), INTELLIGENCE_DIR, noopLogger)
      expect(prompt).toContain('# Job Workflow')
      expect(prompt).toContain('This is the workflow.')
      expect(prompt).not.toContain('initial_phase: planning')
    })

    it('includes agent instructions for the current phase', async () => {
      const workflow = '---\nphases:\n  - name: planning\n    agent: agents/planner.md\n    model: planning\n---\n\n# Workflow'
      setupFs({
        [WORKFLOW_PATH]: workflow,
        [PLANNER_AGENT_PATH]: '# Planner\n\nStep 1: Order the work items.',
      })

      const prompt = await buildSystemPrompt(makeJob(), INTELLIGENCE_DIR, noopLogger)
      expect(prompt).toContain('# Planner')
      expect(prompt).toContain('Step 1: Order the work items.')
      expect(prompt).toContain('Your Role This Phase')
    })

    it('does not inject memory (now on-demand via the read_memory MCP tool)', async () => {
      setupFs({
        [WORKFLOW_PATH]: '',
        '/data/coro-intelligence/memory/MEMORY.md': '# Memory — should NOT appear',
        '/data/coro-intelligence/memory/known-pitfalls.md': 'Do not use X.',
      })

      const prompt = await buildSystemPrompt(makeJob(), INTELLIGENCE_DIR, noopLogger)
      expect(prompt).not.toContain('# Memory — should NOT appear')
      expect(prompt).not.toContain('Do not use X.')
      expect(prompt).not.toContain('Pending Proposals')
    })

    it('does not inject infrastructure context (now in .claude/CLAUDE.md)', async () => {
      setupFs({
        [WORKFLOW_PATH]: '',
      })

      const prompt = await buildSystemPrompt(makeJob(), INTELLIGENCE_DIR, noopLogger)
      expect(prompt).not.toContain('# Infrastructure')
      expect(prompt).not.toContain('BB_WORKSPACE')
    })

    it('always includes job context as the last section', async () => {
      setupFs({
        [WORKFLOW_PATH]: '---\nphases:\n  - name: planning\n    agent: agents/planner.md\n    model: planning\n---\n\n# Job Workflow',
        [PLANNER_AGENT_PATH]: '# Planner Agent',
      })

      const prompt = await buildSystemPrompt(makeJob(), INTELLIGENCE_DIR, noopLogger)
      const lastSectionStart = prompt.lastIndexOf('# Current Job')
      expect(lastSectionStart).toBeGreaterThan(0)
      expect(prompt.slice(lastSectionStart)).toContain('"test-job-1"')
    })
  })

  describe('job context', () => {
    it('includes all key job fields in JSON', async () => {
      setupFs({
        [WORKFLOW_PATH]: '',
      })

      const job = makeJob({
        awaitingEvent: 'pr:fulfilled',
        awaitingPrId: 42,
        escalationMessage: 'Something went wrong',
      })

      const prompt = await buildSystemPrompt(job, INTELLIGENCE_DIR, noopLogger)
      const jsonStart = prompt.indexOf('```json\n') + 8
      const jsonEnd = prompt.indexOf('\n```', jsonStart)
      const ctx = JSON.parse(prompt.slice(jsonStart, jsonEnd)) as Record<string, unknown>

      expect(ctx['jobId']).toBe('test-job-1')
      expect(ctx['type']).toBe('job')
      expect(ctx['phase']).toBe('planning')
      expect(ctx['status']).toBe('planning')
      expect(ctx['triggerSource']).toBe('cli')
      expect(ctx['awaitingEvent']).toBe('pr:fulfilled')
      expect(ctx['awaitingPrId']).toBe(42)
      expect(ctx['escalationMessage']).toBe('Something went wrong')
      expect(ctx['params']).toEqual({ serviceName: 'my-svc', repoSlug: 'my-svc', reviewers: ['alice'] })
    })

    it('nulls out optional fields when not set', async () => {
      setupFs({
        [WORKFLOW_PATH]: '',
      })

      const prompt = await buildSystemPrompt(makeJob(), INTELLIGENCE_DIR, noopLogger)
      const jsonStart = prompt.indexOf('```json\n') + 8
      const jsonEnd = prompt.indexOf('\n```', jsonStart)
      const ctx = JSON.parse(prompt.slice(jsonStart, jsonEnd)) as Record<string, unknown>

      expect(ctx['awaitingEvent']).toBeNull()
      expect(ctx['awaitingPrId']).toBeNull()
      expect(ctx['escalationMessage']).toBeNull()
    })

    it('includes work items and workItemLoopCount in job context', async () => {
      setupFs({
        [WORKFLOW_PATH]: '',
      })

      const job = makeJob({
        workItems: [
          { name: 'scaffold', status: 'complete', loopCount: 1 },
          { name: 'users-api', status: 'in-progress', loopCount: 0 },
        ],
        workItemLoopCount: 0,
        currentWorkItem: 'users-api',
      })

      const prompt = await buildSystemPrompt(job, INTELLIGENCE_DIR, noopLogger)
      const jsonStart = prompt.indexOf('```json\n') + 8
      const jsonEnd = prompt.indexOf('\n```', jsonStart)
      const ctx = JSON.parse(prompt.slice(jsonStart, jsonEnd)) as Record<string, unknown>

      expect(ctx['workItems']).toEqual([
        { name: 'scaffold', status: 'complete', loopCount: 1 },
        { name: 'users-api', status: 'in-progress', loopCount: 0 },
      ])
      expect(ctx['workItemLoopCount']).toBe(0)
      expect(ctx['currentWorkItem']).toBe('users-api')
    })
  })

  describe('resilience', () => {
    it('continues when workflow file is missing', async () => {
      setupFs({})

      const prompt = await buildSystemPrompt(makeJob(), INTELLIGENCE_DIR, noopLogger)
      expect(prompt).toContain('# Current Job')
    })

    it('continues when agent file is missing', async () => {
      const workflow = '---\nphases:\n  - name: planning\n    agent: agents/missing.md\n    model: planning\n---\n\n# Workflow'
      setupFs({
        [WORKFLOW_PATH]: workflow,
      })

      const prompt = await buildSystemPrompt(makeJob(), INTELLIGENCE_DIR, noopLogger)
      expect(prompt).not.toContain('Your Role This Phase')
      expect(prompt).toContain('# Current Job')
    })

    it('does not load agent when workflow has no front matter', async () => {
      setupFs({
        [WORKFLOW_PATH]: '# Just a plain markdown file\n\nNo YAML here.',
      })

      const prompt = await buildSystemPrompt(makeJob(), INTELLIGENCE_DIR, noopLogger)
      expect(prompt).not.toContain('Your Role This Phase')
    })

    it('does not load agent when current phase has no agent', async () => {
      const workflow = '---\nphases:\n  - name: planning\n    agent: ~\n    model: planning\n---\n\n# Workflow'
      setupFs({
        [WORKFLOW_PATH]: workflow,
      })

      const prompt = await buildSystemPrompt(makeJob(), INTELLIGENCE_DIR, noopLogger)
      expect(prompt).not.toContain('Your Role This Phase')
    })
  })

  describe('section ordering', () => {
    it('places sections in correct order: workflow, agent, job', async () => {
      const workflow = '---\nphases:\n  - name: planning\n    agent: agents/planner.md\n    model: planning\n---\n\n# Workflow Content'
      setupFs({
        [WORKFLOW_PATH]: workflow,
        [PLANNER_AGENT_PATH]: '# Planner Agent',
      })

      const prompt = await buildSystemPrompt(makeJob(), INTELLIGENCE_DIR, noopLogger)

      const workflowIdx = prompt.indexOf('# Workflow Content')
      const agentIdx = prompt.indexOf('# Planner Agent')
      const jobIdx = prompt.indexOf('# Current Job')

      expect(workflowIdx).toBeLessThan(agentIdx)
      expect(agentIdx).toBeLessThan(jobIdx)
    })
  })

  // ── Tracker context ──────────────────────────────────────────────────────
  //
  // Regression coverage for the campaign-planner outage where the agent had
  // no signal that the tracker was configured and silently skipped every
  // tracker_* call. The fix surfaces a `tracker` block on the job context
  // so the agent can branch deterministically; these tests pin the wire
  // shape so future refactors don't drop it.

  describe('tracker context', () => {
    it('omits the tracker key when no trackerInfo is supplied', async () => {
      setupFs({ [WORKFLOW_PATH]: '' })

      const prompt = await buildSystemPrompt(makeJob(), INTELLIGENCE_DIR, noopLogger)
      const ctx = parseJobContext(prompt)

      expect(ctx['tracker']).toBeUndefined()
    })

    it('renders tracker.available=true with provider-specific defaults', async () => {
      setupFs({ [WORKFLOW_PATH]: '' })

      const prompt = await buildSystemPrompt(
        makeJob(),
        INTELLIGENCE_DIR,
        noopLogger,
        { provider: 'github', available: true, defaults: { owner: 'emreertugrul' } },
      )
      const ctx = parseJobContext(prompt)

      expect(ctx['tracker']).toEqual({
        provider: 'github',
        available: true,
        defaults: { owner: 'emreertugrul' },
      })
    })

    it('renders tracker.available=false so the agent skips tracker tools', async () => {
      setupFs({ [WORKFLOW_PATH]: '' })

      const prompt = await buildSystemPrompt(
        makeJob(),
        INTELLIGENCE_DIR,
        noopLogger,
        { provider: 'none', available: false },
      )
      const ctx = parseJobContext(prompt)

      expect(ctx['tracker']).toEqual({ provider: 'none', available: false })
    })
  })
})

// ── computeTrackerPromptContext ───────────────────────────────────────────────
//
// Pure helper consumed by the runner before each phase. Lives in the prompt
// builder so the same module owns both halves of the wire contract — the
// shape produced AND the shape consumed.

describe('computeTrackerPromptContext', () => {
  it('reports available=true for a configured GitHub tracker and exposes the owner default', () => {
    const settings = makeSettings({
      tracker: { provider: 'github' },
      github: { token: 'gh-pat', owner: 'emreertugrul' },
    })
    const tracker = makeTrackerClient({ provider: 'github', available: true })

    const out = computeTrackerPromptContext(settings, tracker)
    expect(out).toEqual({ provider: 'github', available: true, defaults: { owner: 'emreertugrul' } })
  })

  it('preserves the user\'s explicit provider choice even when the client is unavailable', () => {
    // Surfacing the user's intent (rather than hiding it as `none`) lets the
    // dashboard / agent prompt explain *why* the tracker is unusable.
    const settings = makeSettings({
      tracker: { provider: 'github' },
      github: { token: '', owner: '' },
    })
    const tracker = makeTrackerClient({ provider: 'github', available: false })

    const out = computeTrackerPromptContext(settings, tracker)
    expect(out).toEqual({ provider: 'github', available: false })
  })

  it('reports provider=none when no tracker is configured (avoids the JiraTrackerClient stub leak)', () => {
    // The factory falls back to an empty JiraTrackerClient when nothing is
    // wired up; without this normalisation the agent would see `provider:
    // 'jira'` even though the user never picked Jira.
    const settings = makeSettings({})
    const tracker = makeTrackerClient({ provider: 'jira', available: false })

    const out = computeTrackerPromptContext(settings, tracker)
    expect(out).toEqual({ provider: 'none', available: false })
  })

  it('emits the linear teamKey default when configured', () => {
    const settings = makeSettings({
      tracker: { provider: 'linear' },
      linear: { apiKey: 'k', teamKey: 'ENG' },
    })
    const tracker = makeTrackerClient({ provider: 'linear', available: true })

    const out = computeTrackerPromptContext(settings, tracker)
    expect(out).toEqual({ provider: 'linear', available: true, defaults: { teamKey: 'ENG' } })
  })

  it('omits defaults when no provider-specific data is available', () => {
    const settings = makeSettings({ tracker: { provider: 'jira' } })
    const tracker = makeTrackerClient({ provider: 'jira', available: true })

    const out = computeTrackerPromptContext(settings, tracker)
    expect(out).toEqual({ provider: 'jira', available: true })
  })
})

// ── helpers ───────────────────────────────────────────────────────────────────

function parseJobContext(prompt: string): Record<string, unknown> {
  const jsonStart = prompt.indexOf('```json\n') + 8
  const jsonEnd = prompt.indexOf('\n```', jsonStart)
  return JSON.parse(prompt.slice(jsonStart, jsonEnd)) as Record<string, unknown>
}

interface MakeSettingsArgs {
  tracker?: { provider?: 'none' | 'jira' | 'github' | 'linear' }
  github?: { token?: string; owner?: string }
  linear?: { apiKey?: string; teamKey?: string }
}

function makeSettings(args: MakeSettingsArgs): Settings {
  // Cast through unknown — the prompt-builder helper only reads a small
  // slice of `Settings`, so we don't bother fully populating the shape.
  // If new fields are added that the helper actually depends on the
  // related test will fail loudly via undefined access.
  return {
    tracker: args.tracker,
    github: {
      token: args.github?.token ?? '',
      owner: args.github?.owner ?? '',
      baseUrl: 'https://api.github.com',
    },
    ...(args.linear ? { linear: args.linear } : {}),
  } as unknown as Settings
}

function makeTrackerClient(args: { provider: TrackerProvider; available: boolean }): TrackerClient {
  return {
    provider: args.provider,
    isAvailable: () => args.available,
    createEpic: vi.fn(),
    createIssue: vi.fn(),
    linkIssues: vi.fn(),
    getIssue: vi.fn(),
    listChildren: vi.fn(),
    transitionIssue: vi.fn(),
    commentIssue: vi.fn(),
  } as unknown as TrackerClient
}
