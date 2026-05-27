import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildIntakeTools,
  createIntakeRunTool,
  INTAKE_MAX_TRACKER_DESCRIPTION_CHARS,
  INTAKE_TOOL_TIMEOUT_MS,
  summarizeToolCall,
} from '../../src/intake/tools'
import type { PluginRegistry } from '../../src/plugins/registry'
import type { ScmPluginRuntime, TrackerPluginRuntime } from '../../src/plugins/types'

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
})

describe('createIntakeRunTool', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

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
})
