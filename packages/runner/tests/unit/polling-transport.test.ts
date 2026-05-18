import { describe, it, expect, afterEach, vi } from 'vitest'
import { PollingTransport } from '../../src/state/polling-transport'
import type { StateBackend } from '../../src/state/backend'
import type { InboundEvent } from '@coro/cloud-protocol'
import { Job, JobType } from '@coro/cloud-protocol'
import { emptyTokenUsage } from '../../src/jobs/helpers'
import { PluginRegistry } from '../../src/plugins/registry'
import type {
  PluginManifest,
  ScmCloneInfo,
  ScmPluginRuntime,
  ScmPollSnapshot,
  ScmPrComment,
  ScmPrStatus,
} from '../../src/plugins/types'
import type { ExternalRef, NormalizedEvent } from '@coro/cloud-protocol'
import pino from 'pino'
import { z } from 'zod'

// ── Mock factories ──────────────────────────────────────────────────────────
//
// The polling transport now resolves SCM plugins through the registry.
// The mock plugin records the snapshot the test wants returned per poll
// cycle so tests can drive state transitions without re-instantiating.

const logger = pino({ level: 'silent' })

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'test-job-1',
    type: JobType.Job,
    workflowPath: 'workflows/job/workflow.md',
    params: { serviceName: 'svc', repoSlug: 'my-repo' },
    triggerSource: 'cli',
    status: 'awaiting-pr-merge',
    phase: 'coding',
    currentWorkItem: null,
    workItems: [],
    workItemLoopCount: 0,
    prMappings: [{ prId: 42, workItem: 'feat/x', repoSlug: 'my-repo', openedAt: '2026-01-01T00:00:00Z' }],
    interactive: false,
    artifacts: [],
    insights: [],
    tokenUsage: emptyTokenUsage(),
    phaseUsage: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    awaitingPrId: 42,
    ...overrides,
  }
}

function makeMockBackend(jobs: Job[]): StateBackend {
  return {
    listJobs: vi.fn().mockResolvedValue(jobs),
    createJob: vi.fn(),
    getJob: vi.fn(async (id: string) => jobs.find((j) => j.id === id) ?? null),
    updateJob: vi.fn(),
    listJobsByType: vi.fn(),
    listChildJobs: vi.fn().mockResolvedValue([]),
    deleteJob: vi.fn(),
    appendLog: vi.fn(),
    getLog: vi.fn(),
    logLength: vi.fn(),
    mapPrToJob: vi.fn(),
    getJobByPr: vi.fn(),
    addPrMapping: vi.fn(),
    markPrMerged: vi.fn(),
    mapJiraTicketToJob: vi.fn(),
    getJobByJiraTicket: vi.fn(),
    mapExternalRef: vi.fn(),
    getJobByExternalRef: vi.fn(),
    mapRepoToJob: vi.fn(),
    createProposal: vi.fn(),
    listProposals: vi.fn(),
    getProposal: vi.fn(),
    updateProposal: vi.fn(),
  }
}

const mockManifest: PluginManifest = {
  id: 'mock-scm',
  kind: 'scm',
  version: '0.0.0',
  displayName: 'Mock SCM',
  hostCompatibility: '^1.0.0',
  configSchema: z.object({}),
}

interface MockScmPluginHandle {
  plugin: ScmPluginRuntime
  setSnapshot(s: ScmPollSnapshot): void
}

function makeMockScmPlugin(initial: ScmPollSnapshot): MockScmPluginHandle {
  let current = initial

  const plugin: ScmPluginRuntime = {
    manifest: mockManifest,
    kind: 'scm',
    init: async () => {},
    healthcheck: async () => ({ ok: true }),
    dispose: async () => {},
    cloneInfo: (_args): ScmCloneInfo => ({ url: '', envForGit: {} }),
    createPr: async (): Promise<ExternalRef> => ({ kind: 'pull_request', pluginId: mockManifest.id, repoKey: 'r', externalId: '1' }),
    getPrStatus: async (): Promise<ScmPrStatus> => ({ state: current.state, approvalCount: current.approvalCount }),
    listPrComments: async (): Promise<ScmPrComment[]> => [...current.comments],
    postPrComment: async (): Promise<ScmPrComment> => ({ id: '0', body: '', createdAt: '', updatedAt: '' }),
    replyToComment: async (): Promise<ScmPrComment> => ({ id: '0', body: '', createdAt: '', updatedAt: '' }),
    pollPr: async (_ref: ExternalRef): Promise<ScmPollSnapshot> => current,
    normalizeInbound: (): NormalizedEvent | null => null,
    matchesRemote: () => true,
  }

  return {
    plugin,
    setSnapshot: (s) => { current = s },
  }
}

function makeRegistry(plugin: ScmPluginRuntime): PluginRegistry {
  const r = new PluginRegistry({ scm: plugin.manifest.id })
  r.register(plugin)
  return r
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('PollingTransport', () => {
  let transport: PollingTransport

  afterEach(async () => {
    if (transport) await transport.disconnect()
  })

  describe('lifecycle', () => {
    it('starts disconnected', () => {
      const backend = makeMockBackend([])
      const { plugin } = makeMockScmPlugin({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] })
      transport = new PollingTransport({
        stateBackend: backend,
        plugins: makeRegistry(plugin),
        logger,
        intervalMs: 60_000,
      })
      expect(transport.isConnected()).toBe(false)
    })

    it('connects and disconnects', async () => {
      const backend = makeMockBackend([])
      const { plugin } = makeMockScmPlugin({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] })
      transport = new PollingTransport({
        stateBackend: backend,
        plugins: makeRegistry(plugin),
        logger,
        intervalMs: 60_000,
      })

      await transport.connect()
      expect(transport.isConnected()).toBe(true)

      await transport.disconnect()
      expect(transport.isConnected()).toBe(false)
    })
  })

  describe('emit', () => {
    it('is a no-op (does not throw)', async () => {
      const backend = makeMockBackend([])
      const { plugin } = makeMockScmPlugin({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] })
      transport = new PollingTransport({
        stateBackend: backend,
        plugins: makeRegistry(plugin),
        logger,
      })

      await expect(transport.emit({
        type: 'job:log',
        jobId: 'j1',
        data: { line: 'test' },
      })).resolves.toBeUndefined()
    })
  })

  describe('poll', () => {
    it('skips poll when no parked jobs exist', async () => {
      const backend = makeMockBackend([])
      const { plugin } = makeMockScmPlugin({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] })
      const pollSpy = vi.spyOn(plugin, 'pollPr')
      transport = new PollingTransport({
        stateBackend: backend,
        plugins: makeRegistry(plugin),
        logger,
      })

      await transport.poll()
      expect(pollSpy).not.toHaveBeenCalled()
    })

    it('skips jobs without awaitingPrId', async () => {
      const job = makeJob({ awaitingPrId: undefined })
      const backend = makeMockBackend([job])
      const { plugin } = makeMockScmPlugin({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] })
      const pollSpy = vi.spyOn(plugin, 'pollPr')
      transport = new PollingTransport({
        stateBackend: backend,
        plugins: makeRegistry(plugin),
        logger,
      })

      await transport.poll()
      expect(pollSpy).not.toHaveBeenCalled()
    })

    it('caches initial snapshot without delivering events for OPEN PRs', async () => {
      const job = makeJob()
      const backend = makeMockBackend([job])
      const { plugin } = makeMockScmPlugin({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] })
      const events: InboundEvent[] = []
      transport = new PollingTransport({
        stateBackend: backend,
        plugins: makeRegistry(plugin),
        logger,
      })
      transport.onEvent(async (e) => { events.push(e) })

      await transport.poll()

      expect(events).toHaveLength(0)
    })

    it('fires pullrequest:fulfilled immediately when PR is already merged on first poll', async () => {
      const job = makeJob({ awaitingEvent: 'pullrequest:fulfilled' })
      const backend = makeMockBackend([job])
      const { plugin } = makeMockScmPlugin({ state: 'merged', approvalCount: 1, commentCount: 0, comments: [] })
      const events: InboundEvent[] = []
      transport = new PollingTransport({ stateBackend: backend, plugins: makeRegistry(plugin), logger })
      transport.onEvent(async (e) => { events.push(e) })

      await transport.poll()

      expect(events).toHaveLength(1)
      expect(events[0].eventKey).toBe('pullrequest:fulfilled')
    })

    it('fires pullrequest:rejected immediately when PR is already declined on first poll', async () => {
      const job = makeJob({ awaitingEvent: 'pullrequest:rejected' })
      const backend = makeMockBackend([job])
      const { plugin } = makeMockScmPlugin({ state: 'declined', approvalCount: 0, commentCount: 0, comments: [] })
      const events: InboundEvent[] = []
      transport = new PollingTransport({ stateBackend: backend, plugins: makeRegistry(plugin), logger })
      transport.onEvent(async (e) => { events.push(e) })

      await transport.poll()

      expect(events).toHaveLength(1)
      expect(events[0].eventKey).toBe('pullrequest:rejected')
    })

    it('fires pullrequest:approved immediately when PR already has approvals on first poll', async () => {
      const job = makeJob({ awaitingEvent: 'pullrequest:approved' })
      const backend = makeMockBackend([job])
      const { plugin } = makeMockScmPlugin({ state: 'open', approvalCount: 2, commentCount: 0, comments: [] })
      const events: InboundEvent[] = []
      transport = new PollingTransport({ stateBackend: backend, plugins: makeRegistry(plugin), logger })
      transport.onEvent(async (e) => { events.push(e) })

      await transport.poll()

      expect(events).toHaveLength(1)
      expect(events[0].eventKey).toBe('pullrequest:approved')
    })

    it('detects PR merge and delivers event', async () => {
      const job = makeJob()
      const backend = makeMockBackend([job])
      const handle = makeMockScmPlugin({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] })
      const events: InboundEvent[] = []
      transport = new PollingTransport({
        stateBackend: backend,
        plugins: makeRegistry(handle.plugin),
        logger,
      })
      transport.onEvent(async (e) => { events.push(e) })

      await transport.poll()
      expect(events).toHaveLength(0)

      handle.setSnapshot({ state: 'merged', approvalCount: 0, commentCount: 0, comments: [] })

      await transport.poll()
      expect(events).toHaveLength(1)
      expect(events[0].eventKey).toBe('pullrequest:fulfilled')
    })

    it('detects PR approval and delivers event', async () => {
      const job = makeJob()
      const backend = makeMockBackend([job])
      const handle = makeMockScmPlugin({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] })
      const events: InboundEvent[] = []
      transport = new PollingTransport({
        stateBackend: backend,
        plugins: makeRegistry(handle.plugin),
        logger,
      })
      transport.onEvent(async (e) => { events.push(e) })

      await transport.poll()

      handle.setSnapshot({ state: 'open', approvalCount: 1, commentCount: 0, comments: [] })

      await transport.poll()
      expect(events).toHaveLength(1)
      expect(events[0].eventKey).toBe('pullrequest:approved')
    })

    it('detects new comments and delivers events', async () => {
      const job = makeJob()
      const backend = makeMockBackend([job])
      const handle = makeMockScmPlugin({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] })
      const events: InboundEvent[] = []
      transport = new PollingTransport({
        stateBackend: backend,
        plugins: makeRegistry(handle.plugin),
        logger,
      })
      transport.onEvent(async (e) => { events.push(e) })

      await transport.poll()

      handle.setSnapshot({
        state: 'open',
        approvalCount: 0,
        commentCount: 1,
        comments: [{ id: '1', body: 'LGTM!', createdAt: '2026-04-20T12:00:00Z', updatedAt: '2026-04-20T12:00:00Z' }],
      })

      await transport.poll()
      expect(events).toHaveLength(1)
      expect(events[0].eventKey).toBe('pullrequest:comment_created')
    })

    it('detects PR decline and delivers event', async () => {
      const job = makeJob()
      const backend = makeMockBackend([job])
      const handle = makeMockScmPlugin({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] })
      const events: InboundEvent[] = []
      transport = new PollingTransport({
        stateBackend: backend,
        plugins: makeRegistry(handle.plugin),
        logger,
      })
      transport.onEvent(async (e) => { events.push(e) })

      await transport.poll()

      handle.setSnapshot({ state: 'declined', approvalCount: 0, commentCount: 0, comments: [] })

      await transport.poll()
      expect(events).toHaveLength(1)
      expect(events[0].eventKey).toBe('pullrequest:rejected')
    })

    it('resolves repoSlug from prMappings', async () => {
      const job = makeJob({
        params: {},
        prMappings: [{ prId: 42, workItem: 'f', repoSlug: 'mapped-repo', openedAt: '2026-01-01' }],
      })
      const backend = makeMockBackend([job])
      const { plugin } = makeMockScmPlugin({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] })
      const pollSpy = vi.spyOn(plugin, 'pollPr')
      transport = new PollingTransport({
        stateBackend: backend,
        plugins: makeRegistry(plugin),
        logger,
      })

      await transport.poll()
      expect(pollSpy).toHaveBeenCalled()
      const ref = pollSpy.mock.calls[0]![0]
      expect(ref.repoKey).toBe('mapped-repo')
      expect(ref.externalId).toBe('42')
    })

    it('polls parked jobs with empty prMappings when repo is in params', async () => {
      const job = makeJob({
        params: { repo: 'ai-test-repository' },
        prMappings: [],
      })
      const backend = makeMockBackend([job])
      const { plugin } = makeMockScmPlugin({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] })
      const pollSpy = vi.spyOn(plugin, 'pollPr')
      transport = new PollingTransport({
        stateBackend: backend,
        plugins: makeRegistry(plugin),
        logger,
      })

      await transport.poll()
      expect(pollSpy).toHaveBeenCalled()
      const ref = pollSpy.mock.calls[0]![0]
      expect(ref.repoKey).toBe('ai-test-repository')
    })

    it('skips parked jobs whose ref cannot be resolved', async () => {
      const job = makeJob({
        params: {},
        prMappings: [],
      })
      const backend = makeMockBackend([job])
      const { plugin } = makeMockScmPlugin({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] })
      const pollSpy = vi.spyOn(plugin, 'pollPr')
      transport = new PollingTransport({
        stateBackend: backend,
        plugins: makeRegistry(plugin),
        logger,
      })

      await transport.poll()
      expect(pollSpy).not.toHaveBeenCalled()
    })

    it('routes polls to the SCM plugin whose matchesRemote claims the repoKey, even when another SCM is the registry default', async () => {
      // Regression: when both bitbucket and github plugins are
      // installed, polling-transport used to fall back to the registry
      // default for `pluginId`, which silently sent github URLs to the
      // bitbucket poller (404s every cycle).
      const job = makeJob({
        params: { serviceName: 'svc', repoSlug: 'https://github.com/acme/repo' },
        prMappings: [{ prId: 7, workItem: 'feat/x', repoSlug: 'https://github.com/acme/repo', openedAt: '2026-01-01T00:00:00Z' }],
        awaitingPrId: 7,
      })
      const backend = makeMockBackend([job])

      const bitbucket = makeMockScmPlugin({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] })
      bitbucket.plugin = {
        ...bitbucket.plugin,
        manifest: { ...mockManifest, id: 'bitbucket' },
        matchesRemote: (url: string) => /bitbucket\.org/.test(url),
      } as ScmPluginRuntime

      const github = makeMockScmPlugin({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] })
      github.plugin = {
        ...github.plugin,
        manifest: { ...mockManifest, id: 'github' },
        matchesRemote: (url: string) => /github\.com/.test(url),
      } as ScmPluginRuntime

      const bbSpy = vi.spyOn(bitbucket.plugin, 'pollPr')
      const ghSpy = vi.spyOn(github.plugin, 'pollPr')

      // bitbucket is the registry default — exercise the bug condition.
      const registry = new PluginRegistry({ scm: 'bitbucket' })
      registry.register(bitbucket.plugin)
      registry.register(github.plugin)

      transport = new PollingTransport({ stateBackend: backend, plugins: registry, logger })
      await transport.poll()

      expect(bbSpy).not.toHaveBeenCalled()
      expect(ghSpy).toHaveBeenCalledTimes(1)
    })
  })
})
