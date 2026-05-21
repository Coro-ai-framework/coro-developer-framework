import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs/promises'
import { z } from 'zod'
import { buildSystemPrompt, computeGuardrailsPromptContext, computeScmPromptContext, computeTrackerPromptContext } from '../../src/prompt/builder'
import type { Settings } from '../../src/config/settings'
import type { TrackerClient, TrackerProvider } from '../../src/clients/tracker'
import { PluginRegistry, type ScmPluginRuntime } from '../../src/plugins'
import { JobType, type Job } from '@coro/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'

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

  // ── Insight rendering ──────────────────────────────────────────────────
  //
  // Coverage for the campaign sibling-insight carry-over: when a child job
  // is dispatched with insights inherited from earlier siblings, those
  // insights MUST surface in the prompt with clear sibling provenance so
  // the agent can tell its own findings apart from the pre-loaded ones.

  describe('insight rendering', () => {
    it('omits the insights section entirely when none are present', async () => {
      setupFs({ [WORKFLOW_PATH]: '' })

      const prompt = await buildSystemPrompt(makeJob({ insights: [] }), INTELLIGENCE_DIR, noopLogger)
      expect(prompt).not.toContain('Insights from Upstream Agents')
    })

    it('renders own-job insights without sibling provenance', async () => {
      setupFs({ [WORKFLOW_PATH]: '' })

      const prompt = await buildSystemPrompt(
        makeJob({
          insights: [{
            phase: 'coding',
            category: 'workaround',
            summary: 'Used inline-URL git push',
            detail: 'Sandbox blocks .git/config writes.',
            suggestion: 'git push "https://x-access-token:$GH_TOKEN@github.com/$GH_OWNER/$REPO.git" $BRANCH',
          }],
        }),
        INTELLIGENCE_DIR,
        noopLogger,
      )

      expect(prompt).toContain('Insights from Upstream Agents')
      expect(prompt).toContain('[coding] workaround')
      expect(prompt).not.toContain('[campaign sibling:')
    })

    it('renders sibling-inherited insights with explicit provenance and a fresher-than-memory lead', async () => {
      setupFs({ [WORKFLOW_PATH]: '' })

      const prompt = await buildSystemPrompt(
        makeJob({
          insights: [
            {
              phase: 'coding',
              category: 'sandbox-quirk',
              summary: 'dotnet restore hangs without --configfile',
              detail: 'Sandbox blocks api.nuget.org; restore silently spins.',
              suggestion: 'dotnet restore --configfile NuGet.Config',
              sourceChildName: 'db-infrastructure',
            },
            {
              phase: 'coding',
              category: 'toolchain-pitfall',
              summary: 'Solution-level dotnet build hangs',
              detail: 'Per-project build works.',
              suggestion: 'dotnet build src/<proj>/<proj>.csproj',
              sourceChildName: 'db-infrastructure',
            },
          ],
        }),
        INTELLIGENCE_DIR,
        noopLogger,
      )

      expect(prompt).toContain('[campaign sibling: db-infrastructure · coding] sandbox-quirk')
      expect(prompt).toContain('[campaign sibling: db-infrastructure · coding] toolchain-pitfall')
      expect(prompt).toContain('fresher than memory')
      expect(prompt).toContain('dotnet restore --configfile NuGet.Config')
    })

    it('omits rejected insights from the prompt (audit-only on the job record)', async () => {
      setupFs({ [WORKFLOW_PATH]: '' })

      const prompt = await buildSystemPrompt(
        makeJob({
          insights: [
            {
              phase: 'coding',
              category: 'workaround',
              summary: 'Keep this recipe',
              detail: 'Still useful.',
              status: 'approved',
            },
            {
              phase: 'coding',
              category: 'spec-ambiguity',
              summary: 'Declined noise',
              detail: 'User said no.',
              status: 'rejected',
            },
          ],
        }),
        INTELLIGENCE_DIR,
        noopLogger,
      )

      expect(prompt).toContain('Keep this recipe')
      expect(prompt).not.toContain('Declined noise')
      expect(prompt).not.toContain('User said no.')
    })

    it('uses the standard lead when own-job and sibling insights are mixed (sibling provenance still wins line-by-line)', async () => {
      setupFs({ [WORKFLOW_PATH]: '' })

      const prompt = await buildSystemPrompt(
        makeJob({
          insights: [
            {
              phase: 'planning',
              category: 'spec-ambiguity',
              summary: 'Ambiguous reviewer mapping',
              detail: 'No alias for "ops".',
            },
            {
              phase: 'coding',
              category: 'sandbox-quirk',
              summary: 'dotnet restore hang',
              detail: 'Inherited recipe',
              sourceChildName: 'db-infrastructure',
            },
          ],
        }),
        INTELLIGENCE_DIR,
        noopLogger,
      )

      // Mixed mode → fresher-than-memory lead is shown because at least one
      // sibling insight is present; the agent should still process the
      // own-job entry, which is rendered without the sibling marker.
      expect(prompt).toContain('fresher than memory')
      expect(prompt).toContain('[planning] spec-ambiguity')
      expect(prompt).toContain('[campaign sibling: db-infrastructure · coding] sandbox-quirk')
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

    it('renders scm context when supplied', async () => {
      setupFs({ [WORKFLOW_PATH]: '' })

      const prompt = await buildSystemPrompt(
        makeJob(),
        INTELLIGENCE_DIR,
        noopLogger,
        { provider: 'none', available: false },
        { available: true, resolved: 'github', installed: ['github'], default: 'github' },
      )
      const ctx = parseJobContext(prompt)

      expect(ctx['scm']).toEqual({
        available: true,
        resolved: 'github',
        installed: ['github'],
        default: 'github',
      })
    })

    it('includes workspace layout when jobWorkingDir is supplied', async () => {
      setupFs({ [WORKFLOW_PATH]: '' })

      const prompt = await buildSystemPrompt(
        makeJob({ params: { repoSlug: 'my-svc' } }),
        INTELLIGENCE_DIR,
        noopLogger,
        undefined,
        undefined,
        undefined,
        undefined,
        '/work/job-1',
      )

      expect(prompt).toContain('## Workspace layout')
      expect(prompt).toContain('/work/job-1/my-svc')
      expect(prompt).toContain('{language}-conventions')
      expect(prompt).not.toMatch(/\bgo build\b/)

      const ctx = parseJobContext(prompt)
      expect(ctx['workspace']).toEqual({
        jobWorkingDir: '/work/job-1',
        repoCheckoutDir: 'my-svc',
        repoCheckoutAbsDir: '/work/job-1/my-svc',
      })
    })

    it('omits the guardrails key when no guardrailsInfo is supplied', async () => {
      setupFs({ [WORKFLOW_PATH]: '' })

      const prompt = await buildSystemPrompt(makeJob(), INTELLIGENCE_DIR, noopLogger)
      const ctx = parseJobContext(prompt)

      expect(ctx['guardrails']).toBeUndefined()
    })

    it('renders guardrails context when supplied', async () => {
      setupFs({ [WORKFLOW_PATH]: '' })

      const guardrailsInfo = computeGuardrailsPromptContext({
        guardrails: {
          rules: [{ id: 'pr-diff-size', config: { maxLines: 1000, maxFiles: 40 } }],
        },
      })
      const prompt = await buildSystemPrompt(
        makeJob(),
        INTELLIGENCE_DIR,
        noopLogger,
        undefined,
        undefined,
        guardrailsInfo,
      )
      const ctx = parseJobContext(prompt)

      expect(ctx['guardrails']).toEqual(guardrailsInfo)
      const prDiffSize = (ctx['guardrails'] as { rules: Array<{ id: string; config?: { maxLines?: number } }> })
        .rules.find(r => r.id === 'pr-diff-size')
      expect(prDiffSize?.config?.maxLines).toBe(1000)
    })
  })
})

describe('computeGuardrailsPromptContext', () => {
  it('merges bundled defaults with user overrides', () => {
    const out = computeGuardrailsPromptContext({
      guardrails: {
        rules: [{ id: 'pr-diff-size', config: { maxLines: 1500 } }],
      },
    })
    const rule = out.rules.find(r => r.id === 'pr-diff-size')
    expect(rule?.config?.maxLines).toBe(1500)
    expect(out.enabled).toBe(true)
  })
})

describe('computeScmPromptContext', () => {
  it('reports the resolved default scm plugin', () => {
    const registry = new PluginRegistry()
    registry.register(fakeScmPlugin('github'))

    const out = computeScmPromptContext(makeJob(), registry)
    expect(out).toEqual({ available: true, resolved: 'github', installed: ['github'] })
  })

  it('preserves the requested scm id when one is set on the job', () => {
    const registry = new PluginRegistry({ scm: 'github' })
    registry.register(fakeScmPlugin('github'))
    registry.register(fakeScmPlugin('bitbucket'))

    const out = computeScmPromptContext(makeJob({ params: { repoSlug: 'my-svc', scm: 'bitbucket' } }), registry)
    expect(out).toEqual({
      available: true,
      resolved: 'bitbucket',
      requested: 'bitbucket',
      default: 'github',
      installed: ['bitbucket', 'github'],
    })
  })

  it('reports available=false when no scm plugin resolves', () => {
    const out = computeScmPromptContext(makeJob(), new PluginRegistry())
    expect(out).toEqual({ available: false, resolved: 'none', installed: [] })
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

function fakeScmPlugin(id: string): ScmPluginRuntime {
  return {
    manifest: {
      id,
      kind: 'scm',
      version: '0.0.1',
      displayName: id,
      hostCompatibility: '*',
      configSchema: z.object({}),
    },
    kind: 'scm',
    init: async () => {},
    healthcheck: async () => ({ ok: true }),
    dispose: async () => {},
    cloneInfo: () => ({ url: 'fake', envForGit: {} }),
    createPr: async () => ({ kind: 'pull_request', pluginId: id, repoKey: 'repo', externalId: '1' }),
    getPrStatus: async () => ({ state: 'open', approvalCount: 0 }),
    listPrComments: async () => [],
    postPrComment: async (_ref, body) => ({ id: '1', body, createdAt: '', updatedAt: '' }),
    replyToComment: async (_ref, parentId, body) => ({ id: '2', body, createdAt: '', updatedAt: '', parentId }),
    pollPr: async () => ({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] }),
    normalizeInbound: () => null,
    matchesRemote: () => false,
  }
}
