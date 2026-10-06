import * as path from 'path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createIsolatedGit } from '../../src/clients/git-auth'
import {
  buildIntakeTools,
  createIntakeRunTool,
  DELEGATE_INVESTIGATION_TOOL,
  INTAKE_CHECKOUT_TIMEOUT_MS,
  INTAKE_MAX_SUBAGENT_TASKS,
  INTAKE_MAX_TRACKER_DESCRIPTION_CHARS,
  INTAKE_SUBAGENT_TIMEOUT_MS,
  INTAKE_TOOL_TIMEOUT_MS,
  summarizeToolCall,
} from '../../src/intake/tools'
import { PluginRegistry } from '../../src/plugins/registry'
import type { ScmPluginRuntime, TrackerPluginRuntime } from '../../src/plugins/types'
import { materialiseSourceSnapshot } from '../../src/tools/upstream-source'
import { makeMockJob } from '../mcp/fixtures'

vi.mock('../../src/tools/upstream-source', () => ({
  SOURCE_SNAPSHOT_DEFAULT_REF: 'default',
  materialiseSourceSnapshot: vi.fn(),
}))

vi.mock('../../src/clients/git-auth', async () => {
  const actual = await vi.importActual<typeof import('../../src/clients/git-auth')>('../../src/clients/git-auth')
  return { ...actual, createIsolatedGit: vi.fn() }
})

function mockRegistry(parts: {
  trackers?: Partial<TrackerPluginRuntime>[]
  scms?: Partial<ScmPluginRuntime>[]
}): PluginRegistry {
  const plugins = [
    ...(parts.trackers ?? []).map((t, i) => ({
      manifest: { id: t.manifest?.id ?? `tracker-${i}`, kind: 'tracker' as const },
      kind: 'tracker' as const,
      ...t,
    })),
    ...(parts.scms ?? []).map((s, i) => ({
      manifest: { id: s.manifest?.id ?? `scm-${i}`, kind: 'scm' as const },
      kind: 'scm' as const,
      ...s,
    })),
  ]
  return {
    all: () => plugins,
    resolveTracker: ({ tracker }: { tracker?: string } = {}) => {
      const found = tracker
        ? plugins.find(p => p.kind === 'tracker' && p.manifest.id === tracker)
        : plugins.find(p => p.kind === 'tracker')
      if (!found) throw new Error('ambiguous tracker')
      return found as TrackerPluginRuntime
    },
    resolveScm: ({ scm }: { scm?: string } = {}) => {
      const found = scm
        ? plugins.find(p => p.kind === 'scm' && p.manifest.id === scm)
        : plugins.find(p => p.kind === 'scm')
      if (!found) throw new Error('ambiguous scm')
      return found as ScmPluginRuntime
    },
  } as unknown as PluginRegistry
}

describe('buildIntakeTools', () => {
  it('includes only tools backed by installed plugins', () => {
    const tools = buildIntakeTools(mockRegistry({
      trackers: [{ getIssue: async () => ({ key: 'X', url: '', summary: '', status: '' }) }],
      scms: [{ readFile: async () => ({ content: 'a', encoding: 'utf-8' as const }), cloneInfo: () => ({ url: '', envForGit: {} }), pollPr: async () => ({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] }), matchesRemote: () => false, normalizeInbound: () => null }],
    }))
    const names = tools.map(t => t.name)
    expect(names).toContain('tracker_get_issue')
    expect(names).toContain('scm_read_file')
    expect(names).not.toContain('tracker_search_issues')
    expect(names).not.toContain('scm_search_code')
    expect(names).not.toContain('scm_list_files')
    expect(names).not.toContain('list_past_jobs')
    expect(names).not.toContain('get_past_job')
    expect(names).not.toContain('delegate_investigation')
  })

  it('keeps delegate_investigation out of the lookup tool list', () => {
    const schema = DELEGATE_INVESTIGATION_TOOL.inputSchema as {
      properties: { tasks: { type: string; maxItems: number } }
    }
    expect(schema.properties.tasks.type).toBe('array')
    expect(schema.properties.tasks.maxItems).toBe(INTAKE_MAX_SUBAGENT_TASKS)
    expect(buildIntakeTools(mockRegistry({})).map(t => t.name)).not.toContain('delegate_investigation')
  })

  it('offers scm_checkout for any installed scm plugin, even without file APIs', () => {
    const tools = buildIntakeTools(mockRegistry({ scms: [{}] }))
    const checkout = tools.find(t => t.name === 'scm_checkout')
    expect(checkout).toBeDefined()
    expect(checkout!.description).toContain('Read-only snapshot')
    expect(checkout!.inputSchema).toMatchObject({ required: ['repo'] })
    expect(tools.map(t => t.name)).not.toContain('scm_read_file')
  })

  it('exposes scm_list_files when a plugin implements listFiles', () => {
    const tools = buildIntakeTools(mockRegistry({
      scms: [{
        listFiles: async () => [],
        cloneInfo: () => ({ url: '', envForGit: {} }),
        pollPr: async () => ({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] }),
        matchesRemote: () => false,
        normalizeInbound: () => null,
      }],
    }))
    const listFiles = tools.find(t => t.name === 'scm_list_files')
    expect(listFiles).toBeDefined()
    expect(listFiles!.inputSchema).toMatchObject({ required: ['repo'] })
  })

  it('exposes past-job tools only when a state backend is provided', () => {
    const empty = mockRegistry({})
    expect(buildIntakeTools(empty).map(t => t.name)).not.toContain('list_past_jobs')
    const withJobs = buildIntakeTools(empty, {
      stateBackend: { listJobs: async () => [], getJob: async () => null } as never,
    })
    expect(withJobs.map(t => t.name)).toEqual([
      'list_past_jobs',
      'get_past_job',
      'read_past_job_artifact',
      'list_past_job_files',
      'read_past_job_file',
    ])
  })
})

describe('createIntakeRunTool', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.mocked(materialiseSourceSnapshot).mockReset()
    vi.mocked(createIsolatedGit).mockReset()
  })

  function snapshotOf(over: Record<string, unknown> = {}) {
    return {
      repo: 'acme/api',
      ref: 'k8s-staging',
      requestedRef: 'k8s-staging',
      commit: 'abc123',
      at: '2026-01-01T00:00:00.000Z',
      absDir: '/scratch/repos/acme_api@k8s-staging',
      cloned: true,
      ...over,
    }
  }

  it('dispatches tracker_get_issue to the plugin', async () => {
    const getIssue = vi.fn(async (key: string) => ({ key, url: 'u', summary: 's', status: 'open' }))
    const registry = mockRegistry({
      trackers: [{ manifest: { id: 'jira' }, getIssue }],
    })
    const runTool = createIntakeRunTool(registry, new AbortController().signal)
    const out = await runTool('tracker_get_issue', { key: 'PROJ-1' })
    expect(getIssue).toHaveBeenCalledWith('PROJ-1')
    expect(out).toMatchObject({ key: 'PROJ-1' })
  })

  it('times out stuck tool calls', async () => {
    vi.useFakeTimers()
    const registry = mockRegistry({
      trackers: [{
        manifest: { id: 'jira' },
        getIssue: () => new Promise(() => {}),
      }],
    })
    const runTool = createIntakeRunTool(registry, new AbortController().signal)
    const pending = runTool('tracker_get_issue', { key: 'PROJ-1' })
    const expectation = expect(pending).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(INTAKE_TOOL_TIMEOUT_MS + 10)
    await expectation
  })

  it('clamps oversized tracker descriptions before handing them to the model', async () => {
    const huge = 'x'.repeat(INTAKE_MAX_TRACKER_DESCRIPTION_CHARS + 5_000)
    const registry = mockRegistry({
      trackers: [{
        manifest: { id: 'jira' },
        getIssue: async () => ({ key: 'PROJ-1', url: 'u', summary: 's', status: 'open', description: huge }),
      }],
    })
    const runTool = createIntakeRunTool(registry, new AbortController().signal)
    const out = (await runTool('tracker_get_issue', { key: 'PROJ-1' })) as { description: string }
    expect(out.description.length).toBeLessThanOrEqual(INTAKE_MAX_TRACKER_DESCRIPTION_CHARS + 20)
    expect(out.description.endsWith('…[truncated]')).toBe(true)
  })

  it('dispatches scm_list_files to the plugin and forwards path/ref when provided', async () => {
    const listFiles = vi.fn(async () => [
      { path: 'src', type: 'dir' as const },
      { path: 'README.md', type: 'file' as const },
    ])
    const registry = mockRegistry({
      scms: [{
        listFiles,
        cloneInfo: () => ({ url: '', envForGit: {} }),
        pollPr: async () => ({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] }),
        matchesRemote: () => false,
        normalizeInbound: () => null,
      }],
    })
    const runTool = createIntakeRunTool(registry, new AbortController().signal)
    const out = await runTool('scm_list_files', { repo: 'a/b', path: 'src', ref: 'master' })
    expect(listFiles).toHaveBeenCalledWith({ repo: 'a/b', path: 'src', ref: 'master' })
    expect(out).toEqual([
      { path: 'src', type: 'dir' },
      { path: 'README.md', type: 'file' },
    ])
  })

  it('omits path when the caller asks for the repo root', async () => {
    const listFiles = vi.fn(async () => [])
    const registry = mockRegistry({
      scms: [{
        listFiles,
        cloneInfo: () => ({ url: '', envForGit: {} }),
        pollPr: async () => ({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] }),
        matchesRemote: () => false,
        normalizeInbound: () => null,
      }],
    })
    const runTool = createIntakeRunTool(registry, new AbortController().signal)
    await runTool('scm_list_files', { repo: 'a/b', path: '' })
    expect(listFiles).toHaveBeenCalledWith({ repo: 'a/b' })
  })

  it('clamps every result in a tracker search', async () => {
    const huge = 'y'.repeat(INTAKE_MAX_TRACKER_DESCRIPTION_CHARS + 1_000)
    const registry = mockRegistry({
      trackers: [{
        manifest: { id: 'jira' },
        searchIssues: async () => [
          { key: 'PROJ-1', url: 'u', summary: 's', status: 'open', description: huge },
          { key: 'PROJ-2', url: 'u', summary: 's', status: 'open', description: 'short one' },
        ],
      }],
    })
    const runTool = createIntakeRunTool(registry, new AbortController().signal)
    const out = (await runTool('tracker_search_issues', { query: 'foo' })) as Array<{ description?: string }>
    expect(out[0]!.description!.endsWith('…[truncated]')).toBe(true)
    expect(out[1]!.description).toBe('short one')
  })

  it('dispatches list_past_jobs and get_past_job through the state backend', async () => {
    const listed = makeMockJob({
      id: 'job-a',
      status: 'complete',
      params: { repoSlug: 'svc', description: 'shipped' },
    })
    const stateBackend = {
      listJobs: vi.fn().mockResolvedValue([listed]),
      getJob: vi.fn().mockResolvedValue(listed),
    }
    const runTool = createIntakeRunTool(mockRegistry({}), new AbortController().signal, {
      stateBackend: stateBackend as never,
    })
    const listedOut = await runTool('list_past_jobs', { repo: 'svc' }) as { jobs: Array<{ id: string }> }
    expect(listedOut.jobs.map(j => j.id)).toEqual(['job-a'])
    const got = await runTool('get_past_job', { jobId: 'job-a' }) as { summary: { id: string }; artifacts: unknown[] }
    expect(got.summary.id).toBe('job-a')
    expect(got.artifacts).toEqual([])
    expect(stateBackend.getJob).toHaveBeenCalledWith('job-a')
  })

  it('dispatches delegate_investigation to the subagent capability', async () => {
    const delegate = vi.fn(async () => [{ task: 'a', ok: true, output: 'found', toolCalls: 1 }])
    const runTool = createIntakeRunTool(mockRegistry({}), new AbortController().signal, {
      subagents: { delegate },
    })
    const out = await runTool('delegate_investigation', { tasks: ['a', 'b'] })
    expect(delegate).toHaveBeenCalledWith(['a', 'b'], expect.any(AbortSignal))
    expect(out).toEqual([{ task: 'a', ok: true, output: 'found', toolCalls: 1 }])
  })

  it('rejects a delegate call with no tasks, too many tasks, or no dispatcher', async () => {
    const runTool = createIntakeRunTool(mockRegistry({}), new AbortController().signal, {
      subagents: { delegate: async () => [] },
    })
    await expect(runTool('delegate_investigation', { tasks: [] })).rejects.toThrow(/non-empty array/)
    await expect(runTool('delegate_investigation', { tasks: ['a', 'b', 'c', 'd', 'e'] })).rejects.toThrow(/at most 4/)
    const bare = createIntakeRunTool(mockRegistry({}), new AbortController().signal)
    await expect(bare('delegate_investigation', { tasks: ['a'] })).rejects.toThrow(/not available/)
  })

  it('gives delegate_investigation a longer timeout than lookups', async () => {
    vi.useFakeTimers()
    const runTool = createIntakeRunTool(mockRegistry({}), new AbortController().signal, {
      subagents: { delegate: () => new Promise(() => {}) },
    })
    let settled = false
    const pending = runTool('delegate_investigation', { tasks: ['look'] }).then(() => { settled = true }, () => { settled = true })
    await vi.advanceTimersByTimeAsync(INTAKE_TOOL_TIMEOUT_MS + 10)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(INTAKE_SUBAGENT_TIMEOUT_MS + INTAKE_TOOL_TIMEOUT_MS)
    await pending
    expect(settled).toBe(true)
  })

  it('checks a repository out through the resolved scm plugin', async () => {
    vi.mocked(materialiseSourceSnapshot).mockResolvedValue(snapshotOf())
    const cloneInfo = vi.fn(() => ({
      url: 'https://user:token@github.com/acme/api.git',
      envForGit: { GIT_ASKPASS: '' },
    }))
    const registry = mockRegistry({
      scms: [{ manifest: { id: 'github', kind: 'scm' }, cloneInfo }],
    })
    const runTool = createIntakeRunTool(registry, new AbortController().signal, { scratchDir: '/scratch' })
    const out = await runTool('scm_checkout', { repo: 'acme/api', ref: 'k8s-staging' })
    expect(cloneInfo).toHaveBeenCalledWith({ repo: 'acme/api' })
    expect(out).toEqual({
      pluginId: 'github',
      repo: 'acme/api',
      ref: 'k8s-staging',
      commit: 'abc123',
      dir: '/scratch/repos/acme_api@k8s-staging',
      reused: false,
    })
    expect(materialiseSourceSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      cloneUrl: 'https://github.com/acme/api.git',
      repo: 'acme/api',
      ref: 'k8s-staging',
      destDir: path.join('/scratch', 'repos', 'acme_api@k8s-staging'),
      extraCloneArgs: ['--progress'],
    }))
    const gitFactory = vi.mocked(materialiseSourceSnapshot).mock.calls[0]![0].gitFactory
    gitFactory!('/tmp/parent')
    expect(createIsolatedGit).toHaveBeenCalledWith(
      '/tmp/parent',
      { GIT_ASKPASS: '' },
      expect.objectContaining({ timeoutMs: 120_000, signal: expect.any(AbortSignal) }),
    )
  })

  it('routes pluginId and reports an ambiguous install instead of guessing', async () => {
    vi.mocked(materialiseSourceSnapshot).mockImplementation(async (args) => snapshotOf({
      repo: args.repo,
      absDir: args.destDir,
      ref: 'main',
    }))
    const registry = new PluginRegistry()
    const github = vi.fn(() => ({ url: 'https://github.com/acme/api.git', envForGit: {} }))
    const bitbucket = vi.fn(() => ({ url: 'https://bitbucket.org/acme/api.git', envForGit: {} }))
    registry.register({ manifest: { id: 'github', kind: 'scm' }, cloneInfo: github } as ScmPluginRuntime)
    registry.register({ manifest: { id: 'bitbucket', kind: 'scm' }, cloneInfo: bitbucket } as ScmPluginRuntime)

    const runTool = createIntakeRunTool(registry, new AbortController().signal, { scratchDir: '/scratch' })
    await expect(runTool('scm_checkout', { repo: 'acme/api' })).rejects.toThrow(/installed=\[github, bitbucket\]/)
    expect(github).not.toHaveBeenCalled()
    expect(bitbucket).not.toHaveBeenCalled()

    await runTool('scm_checkout', { repo: 'acme/api', pluginId: 'bitbucket' })
    expect(bitbucket).toHaveBeenCalledWith({ repo: 'acme/api' })
    expect(github).not.toHaveBeenCalled()
    expect(materialiseSourceSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      cloneUrl: 'https://bitbucket.org/acme/api.git',
    }))
  })

  it('rejects path traversal and a commit sha, and an empty clone url', async () => {
    const registry = mockRegistry({
      scms: [{
        manifest: { id: 'github', kind: 'scm' },
        cloneInfo: () => ({ url: '', envForGit: {} }),
      }],
    })
    const runTool = createIntakeRunTool(registry, new AbortController().signal, { scratchDir: '/scratch' })
    await expect(runTool('scm_checkout', { repo: '..' })).rejects.toThrow(/not a safe path/)
    await expect(runTool('scm_checkout', { repo: 'acme/api', ref: 'a/../../etc' })).rejects.toThrow(/not a safe path/)
    await expect(runTool('scm_checkout', { repo: 'acme/api', ref: 'a'.repeat(40) })).rejects.toThrow(/branch or tag/)
    await expect(runTool('scm_checkout', { repo: 'acme/api' })).rejects.toThrow(/empty clone URL/)
    expect(materialiseSourceSnapshot).not.toHaveBeenCalled()
  })

  it('clones once when two calls ask for the same repo together', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(materialiseSourceSnapshot).mockImplementation(async () => {
      await gate
      return snapshotOf()
    })
    const registry = mockRegistry({
      scms: [{
        manifest: { id: 'github', kind: 'scm' },
        cloneInfo: () => ({ url: 'https://github.com/acme/api.git', envForGit: {} }),
      }],
    })
    const runTool = createIntakeRunTool(registry, new AbortController().signal, { scratchDir: '/scratch' })
    const first = runTool('scm_checkout', { repo: 'acme/api', ref: 'k8s-staging' })
    const second = runTool('scm_checkout', { repo: 'acme/api', ref: 'k8s-staging' })
    expect(materialiseSourceSnapshot).toHaveBeenCalledTimes(1)
    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(materialiseSourceSnapshot).toHaveBeenCalledTimes(1)
  })

  it('gives scm_checkout longer than the lookup timeout', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(materialiseSourceSnapshot).mockReturnValue(new Promise(() => {}))
      const registry = mockRegistry({
        scms: [{
          manifest: { id: 'github', kind: 'scm' },
          cloneInfo: () => ({ url: 'https://github.com/acme/slow.git', envForGit: {} }),
        }],
      })
      const runTool = createIntakeRunTool(registry, new AbortController().signal, { scratchDir: '/scratch-timeout' })
      let settled = false
      const pending = runTool('scm_checkout', { repo: 'acme/slow' }).then(() => { settled = true }, () => { settled = true })
      await vi.advanceTimersByTimeAsync(INTAKE_TOOL_TIMEOUT_MS + 10)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(INTAKE_CHECKOUT_TIMEOUT_MS)
      await pending
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks the permission gate before running a workspace tool', async () => {
    const gate = vi.fn(async () => ({ allow: false, reason: 'not this time' }))
    const runTool = createIntakeRunTool(mockRegistry({}), new AbortController().signal, {
      workspace: { shell: vi.fn(async () => ({ stdout: 'hi', stderr: '', exitCode: 0 })) },
      gate,
    })
    await expect(runTool('shell', { command: 'echo hi' })).rejects.toThrow('not this time')
  })

  it('grants a capability through request_tool_access', async () => {
    const requestCapability = vi.fn(async () => ({ granted: true, mode: 'ask' }))
    const runTool = createIntakeRunTool(mockRegistry({}), new AbortController().signal, { requestCapability })
    await expect(runTool('request_tool_access', { capability: 'shell', reason: 'clone the repo' })).resolves.toEqual({ granted: true, mode: 'ask' })
    expect(requestCapability).toHaveBeenCalledWith('shell', 'clone the repo')
  })
})

describe('summarizeToolCall', () => {
  it('uses the ticket key when available', () => {
    expect(summarizeToolCall('tracker_get_issue', { key: 'PROJ-123' }, {})).toBe('Read PROJ-123')
    expect(summarizeToolCall('tracker_get_issue', {}, {})).toBe('Read ticket')
  })

  it('reports search hit counts', () => {
    expect(summarizeToolCall('tracker_search_issues', { query: 'q' }, [1, 2, 3])).toBe('Found 3 tickets')
    expect(summarizeToolCall('tracker_search_issues', { query: 'q' }, [])).toBe('Found 0 tickets')
    expect(summarizeToolCall('tracker_search_issues', { query: 'q' }, [{}])).toBe('Found 1 ticket')
  })

  it('uses the file path for scm_read_file', () => {
    expect(summarizeToolCall('scm_read_file', { repo: 'a/b', path: 'src/foo.ts' }, {})).toBe('Read src/foo.ts')
    expect(summarizeToolCall('scm_read_file', {}, {})).toBe('Read file')
  })

  it('reports code hit counts', () => {
    expect(summarizeToolCall('scm_search_code', { query: 'q' }, [{}, {}])).toBe('Found 2 code hits')
    expect(summarizeToolCall('scm_search_code', { query: 'q' }, [{}])).toBe('Found 1 code hit')
  })

  it('reports list_files entry counts and includes the path when present', () => {
    expect(summarizeToolCall('scm_list_files', { repo: 'a/b', path: 'src' }, [{}, {}, {}])).toBe('Listed 3 entries in src')
    expect(summarizeToolCall('scm_list_files', { repo: 'a/b' }, [{}])).toBe('Listed 1 entry')
    expect(summarizeToolCall('scm_list_files', { repo: 'a/b' }, [])).toBe('Listed 0 entries')
  })

  it('falls back to a generic label for unknown tools', () => {
    expect(summarizeToolCall('something_unknown', {}, {})).toBe('Done')
  })

  it('summarises past-job tools', () => {
    expect(summarizeToolCall('list_past_jobs', {}, { jobs: [{}, {}] })).toBe('Listed 2 past jobs')
    expect(summarizeToolCall('list_past_jobs', {}, { jobs: [{}] })).toBe('Listed 1 past job')
    expect(summarizeToolCall('get_past_job', { jobId: 'job-abc' }, {})).toBe('Opened past job job-abc')
    expect(summarizeToolCall('get_past_job', {}, {})).toBe('Opened past job')
    expect(summarizeToolCall('read_past_job_artifact', { artifactId: 'art-1' }, {})).toBe('Read artefact art-1')
    expect(summarizeToolCall('list_past_job_files', { path: 'src' }, { entries: [{}, {}] })).toBe('Listed 2 job entries in src')
    expect(summarizeToolCall('read_past_job_file', { path: 'plan.md' }, {})).toBe('Read job file plan.md')
  })

  it('summarises workspace tools and access requests', () => {
    expect(summarizeToolCall('shell', { command: 'git status' }, { exitCode: 0 })).toBe('Ran git status (exit 0)')
    expect(summarizeToolCall('web_fetch', { url: 'https://example.com/a' }, {})).toBe('Fetched example.com')
    expect(summarizeToolCall('file_read', { path: 'notes.md' }, {})).toBe('Read notes.md')
    expect(summarizeToolCall('request_tool_access', { capability: 'web' }, { granted: true, mode: 'ask' })).toBe('Enabled: web')
  })

  it('summarises a checkout, including a reuse', () => {
    expect(summarizeToolCall('scm_checkout', { repo: 'acme/api', ref: 'k8s-staging' }, { reused: false })).toBe(
      'Checked out acme/api@k8s-staging',
    )
    expect(summarizeToolCall('scm_checkout', { repo: 'acme/api', ref: 'k8s-staging' }, { reused: true })).toBe(
      'Checked out acme/api@k8s-staging (reused)',
    )
    expect(summarizeToolCall('scm_checkout', { repo: 'acme/api' }, {})).toBe('Checked out acme/api')
  })

  it('summarises a delegated investigation', () => {
    expect(summarizeToolCall('delegate_investigation', {}, [{ ok: true }, { ok: false }])).toBe(
      'Delegated 2 investigations (1 ok)',
    )
  })
})
