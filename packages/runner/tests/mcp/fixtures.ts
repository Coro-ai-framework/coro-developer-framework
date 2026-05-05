import { vi } from 'vitest'
import type { ChildProcess } from 'child_process'
import { JobType, STATUS_QUEUED, emptyTokenUsage } from '../../src/jobs/types'
import type { ToolContext } from '../../src/tools/types'
import type { BitBucketClient } from '../../src/clients/bitbucket'
import type { LokiClient } from '../../src/clients/loki'
import type { TempoClient } from '../../src/clients/tempo'
import type { JiraClient } from '../../src/clients/jira'
import type { TrackerClient } from '../../src/clients/tracker'
import type { StateBackend } from '../../src/state/backend'
import { PluginRegistry } from '../../src/plugins/registry'
import type {
  PluginManifest,
  ScmPluginRuntime,
  TrackerPluginRuntime,
} from '../../src/plugins/types'
import { z } from 'zod'

export function makeMockJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-mcp-test',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { repoSlug: 'svc', reviewers: ['reviewer-1'] },
    triggerSource: 'cli' as const,
    status: STATUS_QUEUED,
    phase: 'coding',
    currentWorkItem: null,
    workItems: [],
    workItemLoopCount: 0,
    prMappings: [],
    interactive: false,
    artifacts: [],
    insights: [],
    tokenUsage: emptyTokenUsage(),
    phaseUsage: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

// ── Stub plugin builders ─────────────────────────────────────────────────────
//
// The legacy `bb_*`/`gh_*`/`jira_*` MCP handlers now route through
// the plugin registry. Tests that assert "BitBucket got called" need
// to spy on the registered plugin's methods rather than on the bare
// client. These builders return both the runtime and a record of
// `vi.fn()` spies so tests can keep their assertion style.

function manifest(id: string, kind: 'scm' | 'tracker'): PluginManifest {
  return {
    id,
    kind,
    version: '0.0.0',
    displayName: id,
    hostCompatibility: '^1.0.0',
    configSchema: z.object({}),
  }
}

export interface ScmStubSpies {
  createRepo: ReturnType<typeof vi.fn>
  createPr: ReturnType<typeof vi.fn>
  getPrStatus: ReturnType<typeof vi.fn>
  listPrComments: ReturnType<typeof vi.fn>
  postPrComment: ReturnType<typeof vi.fn>
  replyToComment: ReturnType<typeof vi.fn>
  approvePr: ReturnType<typeof vi.fn>
  mergePr: ReturnType<typeof vi.fn>
  pollPr: ReturnType<typeof vi.fn>
}

export function makeStubScmPlugin(id: string): { plugin: ScmPluginRuntime; spies: ScmStubSpies } {
  const spies: ScmStubSpies = {
    createRepo: vi.fn().mockResolvedValue({
      kind: 'repo', pluginId: id, externalId: 'ws/new-repo', url: `https://${id}/ws/new-repo`,
    }),
    createPr: vi.fn().mockResolvedValue({
      kind: 'pull_request', pluginId: id, repoKey: 'r', externalId: '99', url: `https://${id}/pr/99`,
    }),
    getPrStatus: vi.fn().mockResolvedValue({ state: 'open', approvalCount: 1 }),
    listPrComments: vi.fn().mockResolvedValue([
      { id: '1', body: 'hello', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ]),
    postPrComment: vi.fn().mockResolvedValue({ id: '2', body: 'hi', createdAt: '', updatedAt: '' }),
    replyToComment: vi.fn().mockResolvedValue({ id: '3', body: 'reply', createdAt: '', updatedAt: '' }),
    approvePr: vi.fn().mockResolvedValue(undefined),
    mergePr: vi.fn().mockResolvedValue(undefined),
    pollPr: vi.fn().mockResolvedValue({ state: 'open', approvalCount: 1, commentCount: 0, comments: [] }),
  }

  const plugin: ScmPluginRuntime = {
    manifest: manifest(id, 'scm'),
    kind: 'scm',
    init: async () => {},
    healthcheck: async () => ({ ok: true }),
    dispose: async () => {},
    cloneInfo: () => ({ url: '', envForGit: {} }),
    createRepo: spies.createRepo,
    createPr: spies.createPr,
    getPrStatus: spies.getPrStatus,
    listPrComments: spies.listPrComments,
    postPrComment: spies.postPrComment,
    replyToComment: spies.replyToComment,
    approvePr: spies.approvePr,
    mergePr: spies.mergePr,
    pollPr: spies.pollPr,
    normalizeInbound: () => null,
    matchesRemote: () => true,
  }

  return { plugin, spies }
}

export interface TrackerStubSpies {
  getIssue: ReturnType<typeof vi.fn>
  listChildren: ReturnType<typeof vi.fn>
  commentIssue: ReturnType<typeof vi.fn>
  transitionIssue: ReturnType<typeof vi.fn>
  createIssue: ReturnType<typeof vi.fn>
  createEpic: ReturnType<typeof vi.fn>
  linkIssues: ReturnType<typeof vi.fn>
}

export function makeStubTrackerPlugin(id: string): { plugin: TrackerPluginRuntime; spies: TrackerStubSpies } {
  const spies: TrackerStubSpies = {
    getIssue: vi.fn().mockResolvedValue({ key: 'X-1', summary: 's', status: 'Open', url: '' }),
    listChildren: vi.fn().mockResolvedValue([]),
    commentIssue: vi.fn().mockResolvedValue(undefined),
    transitionIssue: vi.fn().mockResolvedValue(undefined),
    createIssue: vi.fn().mockResolvedValue({ key: 'X-2', summary: 's', status: 'Open', url: '' }),
    createEpic: vi.fn().mockResolvedValue({ key: 'EPIC-1', summary: 's', status: 'Open', url: '' }),
    linkIssues: vi.fn().mockResolvedValue(undefined),
  }

  const plugin: TrackerPluginRuntime = {
    manifest: manifest(id, 'tracker'),
    kind: 'tracker',
    init: async () => {},
    healthcheck: async () => ({ ok: true }),
    dispose: async () => {},
    getIssue: spies.getIssue,
    listChildren: spies.listChildren,
    commentIssue: spies.commentIssue,
    transitionIssue: spies.transitionIssue,
    createIssue: spies.createIssue,
    createEpic: spies.createEpic,
    linkIssues: spies.linkIssues,
  }

  return { plugin, spies }
}

export interface MockToolContextResult {
  ctx: ToolContext
  scmSpies: Record<string, ScmStubSpies>
  trackerSpies: Record<string, TrackerStubSpies>
}

/**
 * Builds a mock {@link ToolContext} with a populated PluginRegistry.
 * `scmSpies` / `trackerSpies` expose the stub plugin's per-method
 * spies so tests can assert plugin-level invocations after a generic
 * `scm_*` / `tracker_*` (or legacy `bb_*` / `gh_*` / `jira_*` shim)
 * call lands.
 */
export function makeMockToolContextWithSpies(
  overrides: Partial<ToolContext> = {},
): MockToolContextResult {
  const ctx = makeMockToolContext(overrides)
  const scmSpies: Record<string, ScmStubSpies> = {}
  const trackerSpies: Record<string, TrackerStubSpies> = {}

  // Default registry + stubs only when the caller didn't override.
  // Tests that need a custom registry can pass `plugins` explicitly.
  if (!overrides.plugins) {
    const bb = makeStubScmPlugin('bitbucket')
    const gh = makeStubScmPlugin('github')
    const jira = makeStubTrackerPlugin('jira')
    scmSpies['bitbucket'] = bb.spies
    scmSpies['github'] = gh.spies
    trackerSpies['jira'] = jira.spies

    ctx.plugins = new PluginRegistry({ scm: 'bitbucket', tracker: 'jira' })
    ctx.plugins.register(bb.plugin)
    ctx.plugins.register(gh.plugin)
    ctx.plugins.register(jira.plugin)
  }

  return { ctx, scmSpies, trackerSpies }
}

export function makeMockToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const bbCoder = {
    createRepo: vi.fn().mockResolvedValue({ full_name: 'ws/new-repo' }),
    createPr: vi.fn().mockResolvedValue({
      id: 99,
      links: { html: { href: 'https://bb/pr/99' } },
      state: 'OPEN',
    }),
    getPrStatus: vi.fn().mockResolvedValue({ state: 'OPEN', approvals: 1 }),
  } as unknown as BitBucketClient

  const bbReviewer = {
    getComments: vi.fn().mockResolvedValue([
      {
        id: 1,
        content: { raw: 'hello' },
        created_on: '2026-01-01T00:00:00Z',
        parent: undefined,
        inline: undefined,
      },
    ]),
    postComment: vi.fn().mockResolvedValue({ id: 2 }),
    replyToComment: vi.fn().mockResolvedValue({ id: 3 }),
    approvePr: vi.fn().mockResolvedValue(undefined),
    mergePr: vi.fn().mockResolvedValue({ state: 'MERGED' }),
  } as unknown as BitBucketClient

  const stateBackend = {
    getJob: vi.fn().mockImplementation(async () => makeMockJob()),
    updateJob: vi.fn().mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeMockJob(),
      ...patch,
    })),
    appendLog: vi.fn().mockResolvedValue(undefined),
    addPrMapping: vi.fn().mockImplementation(async (_id: string, mapping: Record<string, unknown>) => ({
      ...makeMockJob(),
      prMappings: [mapping],
    })),
    mapPrToJob: vi.fn().mockResolvedValue(undefined),
  } as unknown as StateBackend

  const lokiClient = {
    query: vi.fn().mockResolvedValue({ streams: [] }),
  } as unknown as LokiClient

  const tempoClient = {
    getTrace: vi.fn().mockResolvedValue({ traceId: 'abc' }),
    search: vi.fn().mockResolvedValue({ traces: [] }),
  } as unknown as TempoClient

  const jiraClient = {
    getIssue: vi.fn().mockResolvedValue({ key: 'X-1', fields: {} }),
    postComment: vi.fn().mockResolvedValue({ id: 'c1' }),
    transitionIssue: vi.fn().mockResolvedValue(null),
  } as unknown as JiraClient

  const trackerClient = {
    provider: 'jira' as const,
    isAvailable: () => false,
    createEpic: vi.fn().mockResolvedValue({ available: false, reason: 'mock' }),
    createIssue: vi.fn().mockResolvedValue({ available: false, reason: 'mock' }),
    linkIssues: vi.fn().mockResolvedValue({ available: false, reason: 'mock' }),
    getIssue: vi.fn().mockResolvedValue({ available: false, reason: 'mock' }),
    listChildren: vi.fn().mockResolvedValue({ available: false, reason: 'mock' }),
    transitionIssue: vi.fn().mockResolvedValue({ available: false, reason: 'mock' }),
    commentIssue: vi.fn().mockResolvedValue({ available: false, reason: 'mock' }),
  } as unknown as TrackerClient

  return {
    job: makeMockJob(),
    stateBackend,
    settings: {
      paths: { coroIntelligenceDir: '/tmp/coro-mcp-test', workingDir: '/tmp/work-mcp' },
    } as ToolContext['settings'],
    tenantContext: {
      tenantId: 'solo-test-host',
      mode: 'solo' as const,
      displayName: 'Solo (test-host)',
      overlay: { kind: 'none' as const },
    },
    jobIntelligenceDir: '/tmp/coro-mcp-test',
    gitClient: {} as ToolContext['gitClient'],
    bbCoder,
    bbReviewer,
    ghClient: null,
    ghGitClient: null,
    lokiClient,
    tempoClient,
    jiraClient,
    trackerClient,
    plugins: new PluginRegistry(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as ToolContext['logger'],
    runningServices: new Map<string, ChildProcess>(),
    ...overrides,
  }
}
