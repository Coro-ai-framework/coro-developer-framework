// Tests for the plugin foundation (P0): types, registry shell, refs,
// and the legacy-config translator. No real provider calls — the
// registry is exercised against tiny in-process fakes.

import { describe, it, expect } from 'vitest'
import pino from 'pino'
import { z } from 'zod'
import {
  listBuiltinPluginMetadata,
  PluginRegistry,
  PluginResolutionError,
  isScmPlugin,
  isTrackerPlugin,
  type ScmPluginRuntime,
  type TrackerPluginRuntime,
  type PluginManifest,
  externalIdString,
  repoKeyForStorage,
} from '../../src/plugins'
import {
  resolvePluginsConfig,
  type LocalConfig,
} from '../../src/config/local-config'
import { getJobPluginRequirementIssues, getIncomingPluginSelectionIssues } from '../../src/jobs/plugin-preflight'
import { BUILTIN_PLUGIN_IDS_BY_KIND } from '../../src/plugins/builtin'

// ── Fake plugin runtimes ─────────────────────────────────────────────────────

function makeFakeScmManifest(id: string): PluginManifest {
  return {
    id,
    kind: 'scm',
    version: '0.0.1',
    displayName: id,
    hostCompatibility: '*',
    configSchema: z.object({}),
  }
}

function makeFakeTrackerManifest(id: string): PluginManifest {
  return {
    id,
    kind: 'tracker',
    version: '0.0.1',
    displayName: id,
    hostCompatibility: '*',
    configSchema: z.object({}),
  }
}

function fakeScm(id: string, matches: RegExp = /never-match/): ScmPluginRuntime {
  const manifest = makeFakeScmManifest(id)
  return {
    manifest,
    kind: 'scm',
    init: async () => {},
    healthcheck: async () => ({ ok: true }),
    dispose: async () => {},
    cloneInfo: () => ({ url: 'fake', envForGit: {} }),
    createPr: async () => ({ kind: 'pull_request', pluginId: id, repoKey: 'r', externalId: '1' }),
    getPrStatus: async () => ({ state: 'open', approvalCount: 0 }),
    listPrComments: async () => [],
    postPrComment: async (_r, body) => ({ id: '1', body, createdAt: '', updatedAt: '' }),
    replyToComment: async (_r, parentId, body) => ({ id: '2', body, createdAt: '', updatedAt: '', parentId }),
    pollPr: async () => ({ state: 'open', approvalCount: 0, commentCount: 0, comments: [] }),
    normalizeInbound: () => null,
    matchesRemote: (url) => matches.test(url),
  }
}

function fakeTracker(id: string): TrackerPluginRuntime {
  return {
    manifest: makeFakeTrackerManifest(id),
    kind: 'tracker',
    init: async () => {},
    healthcheck: async () => ({ ok: true }),
    dispose: async () => {},
    getIssue: async (key) => ({ key, url: '', summary: '', status: '' }),
    commentIssue: async () => {},
    transitionIssue: async () => {},
  }
}

// ── Refs ─────────────────────────────────────────────────────────────────────

describe('externalIdString', () => {
  it('passes strings through', () => {
    expect(externalIdString('PROJ-1')).toBe('PROJ-1')
  })
  it('stringifies numbers', () => {
    expect(externalIdString(42)).toBe('42')
  })
  it('throws on null/undefined', () => {
    expect(() => externalIdString(null)).toThrow(/null\/undefined/)
    expect(() => externalIdString(undefined)).toThrow(/null\/undefined/)
  })
})

describe('repoKeyForStorage', () => {
  it('returns repoKey for pull_request', () => {
    expect(
      repoKeyForStorage({ kind: 'pull_request', pluginId: 'gh', repoKey: 'a/b', externalId: '1' }),
    ).toBe('a/b')
  })
  it('throws when pull_request has no repoKey', () => {
    expect(() =>
      repoKeyForStorage({ kind: 'pull_request', pluginId: 'gh', externalId: '1' }),
    ).toThrow(/repoKey/)
  })
  it('returns empty string for ticket without repoKey', () => {
    expect(
      repoKeyForStorage({ kind: 'ticket', pluginId: 'jira', externalId: 'PROJ-1' }),
    ).toBe('')
  })
})

// ── Registry ─────────────────────────────────────────────────────────────────

describe('PluginRegistry', () => {
  it('registers and looks up plugins by id', () => {
    const r = new PluginRegistry()
    const gh = fakeScm('github')
    r.register(gh)
    expect(r.byId('github')).toBe(gh)
    expect(r.byId('missing')).toBeUndefined()
  })

  it('refuses duplicate ids', () => {
    const r = new PluginRegistry()
    r.register(fakeScm('github'))
    expect(() => r.register(fakeScm('github'))).toThrow(/already registered/)
  })

  it('groups by kind', () => {
    const r = new PluginRegistry()
    r.register(fakeScm('github'))
    r.register(fakeScm('bitbucket'))
    r.register(fakeTracker('jira'))
    expect(r.byKind('scm').map(s => s.manifest.id).sort()).toEqual(['bitbucket', 'github'])
    expect(r.byKind('tracker').map(s => s.manifest.id)).toEqual(['jira'])
  })

  it('default(kind) returns the only installed plugin when there is one', () => {
    const r = new PluginRegistry()
    r.register(fakeScm('github'))
    expect(r.default('scm')?.manifest.id).toBe('github')
  })

  it('default(kind) returns undefined when ambiguous and no default set', () => {
    const r = new PluginRegistry()
    r.register(fakeScm('github'))
    r.register(fakeScm('bitbucket'))
    expect(r.default('scm')).toBeUndefined()
  })

  it('default(kind) honours configured defaults', () => {
    const r = new PluginRegistry({ scm: 'bitbucket' })
    r.register(fakeScm('github'))
    r.register(fakeScm('bitbucket'))
    expect(r.default('scm')?.manifest.id).toBe('bitbucket')
  })

  it('default(kind) falls back to the sole installed plugin when the configured default was disabled', () => {
    const r = new PluginRegistry({ scm: 'bitbucket' })
    r.register(fakeScm('github'))
    expect(r.default('scm')?.manifest.id).toBe('github')
    expect(r.resolveScm().manifest.id).toBe('github')
  })

  it('default(kind) stays ambiguous when a disabled default leaves two candidates', () => {
    const r = new PluginRegistry({ scm: 'bitbucket' })
    r.register(fakeScm('github'))
    r.register(fakeScm('gitlab'))
    expect(r.default('scm')).toBeUndefined()
    expect(() => r.resolveScm()).toThrowError(PluginResolutionError)
  })

  it('resolveScm uses params override', () => {
    const r = new PluginRegistry()
    r.register(fakeScm('github'))
    r.register(fakeScm('bitbucket'))
    expect(r.resolveScm({ scm: 'bitbucket' }).manifest.id).toBe('bitbucket')
  })

  it('resolveScm throws PluginResolutionError on ambiguous', () => {
    const r = new PluginRegistry()
    r.register(fakeScm('github'))
    r.register(fakeScm('bitbucket'))
    expect(() => r.resolveScm()).toThrowError(PluginResolutionError)
  })

  it('resolveScm throws when requested id is not installed', () => {
    const r = new PluginRegistry()
    r.register(fakeScm('github'))
    expect(() => r.resolveScm({ scm: 'bitbucket' })).toThrowError(/not installed/)
  })

  it('resolveScm throws when requested id is registered as different kind', () => {
    const r = new PluginRegistry()
    r.register(fakeTracker('foo'))
    expect(() => r.resolveScm({ scm: 'foo' })).toThrowError(/registered as kind/)
  })

  it('resolveByRemote picks plugin whose matchesRemote returns true', () => {
    const r = new PluginRegistry()
    r.register(fakeScm('github', /github\.com/i))
    r.register(fakeScm('bitbucket', /bitbucket\.org/i))
    const got = r.resolveByRemote('https://github.com/acme/repo.git')
    expect(got?.manifest.id).toBe('github')
  })

  it('resolveByRemote returns undefined when no plugin matches', () => {
    const r = new PluginRegistry()
    r.register(fakeScm('github', /github\.com/i))
    expect(r.resolveByRemote('https://gitlab.com/acme/repo.git')).toBeUndefined()
  })

  it('isScmPlugin / isTrackerPlugin narrow correctly', () => {
    const scm = fakeScm('github')
    const trk = fakeTracker('jira')
    expect(isScmPlugin(scm)).toBe(true)
    expect(isScmPlugin(trk)).toBe(false)
    expect(isTrackerPlugin(trk)).toBe(true)
    expect(isTrackerPlugin(scm)).toBe(false)
  })

  it('collectExtensionTools refuses duplicate tool names', () => {
    const r = new PluginRegistry()
    const a = fakeScm('a') as ScmPluginRuntime & { extensionTools?: () => unknown[] }
    a.extensionTools = () => [
      { name: 'shared', description: '', inputSchema: {}, handler: async () => ({}) },
    ]
    const b = fakeScm('b') as ScmPluginRuntime & { extensionTools?: () => unknown[] }
    b.extensionTools = () => [
      { name: 'shared', description: '', inputSchema: {}, handler: async () => ({}) },
    ]
    r.register(a)
    r.register(b)
    expect(() => r.collectExtensionTools()).toThrow(/registered by multiple plugins/)
  })
})

// ── PluginsConfig resolution ────────────────────────────────────────────────
//
// The legacy translator (`legacyConfigToPlugins`) and the corresponding
// `git.*` / `tracker.*` / top-level `anthropic` config blocks were
// removed in the single-source-of-truth refactor. All provider
// credentials now live exclusively under
// `plugins.installed.<id>.config`.

describe('resolvePluginsConfig', () => {
  it('returns the explicit plugins block when present', () => {
    const cfg: LocalConfig = {
      plugins: {
        installed: {
          'github': { enabled: true, config: { owner: 'me', token: 't' } },
        },
        defaults: { scm: 'github' },
      },
    }
    const got = resolvePluginsConfig(cfg)
    expect(got.installed['github']).toBeDefined()
    expect(got.defaults?.scm).toBe('github')
  })

  it('seeds local SCM when no SCM plugin is enabled yet', () => {
    expect(resolvePluginsConfig({})).toEqual({
      defaults: { scm: 'local' },
      installed: { local: { enabled: true, config: {} } },
    })
  })

  it('tolerates a null config (used in early bootstrap paths)', () => {
    expect(resolvePluginsConfig(null)).toEqual({
      defaults: { scm: 'local' },
      installed: { local: { enabled: true, config: {} } },
    })
  })
})

describe('listBuiltinPluginMetadata', () => {
  it('describes every shipped builtin plugin with activation guidance', async () => {
    const logger = pino({ level: 'silent' })
    const got = await listBuiltinPluginMetadata(logger)
    const ids = got.map(entry => entry.manifest.id).sort()

    expect(ids).toEqual([
      ...BUILTIN_PLUGIN_IDS_BY_KIND['scm'],
      ...BUILTIN_PLUGIN_IDS_BY_KIND['tracker'],
      ...BUILTIN_PLUGIN_IDS_BY_KIND['executor'],
    ].sort())
    for (const entry of got) {
      expect(entry.manifest.displayName.length).toBeGreaterThan(0)
      expect(entry.activationHint.length).toBeGreaterThan(0)
    }
  })
})

describe('getJobPluginRequirementIssues', () => {
  it('reports missing scm setup before a repo job starts', () => {
    const issues = getJobPluginRequirementIssues({ params: { repoSlug: 'weather-service' } }, new PluginRegistry())
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toMatch(/SCM setup incomplete/)
    expect(issues[0]?.message).toMatch(/Settings > Git/)
  })

  it('does not require a tracker plugin at dispatch, even with a ticket id', () => {
    const issues = getJobPluginRequirementIssues(
      { params: { jiraTicketId: 'ENG-1234', tracker: 'jira' } },
      new PluginRegistry(),
    )
    expect(issues).toEqual([])
  })

  it('passes a repo+ticket job when SCM resolves and tracker does not', () => {
    const registry = new PluginRegistry()
    registry.register(fakeScm('github'))
    const issues = getJobPluginRequirementIssues(
      { params: { repoSlug: 'weather-service', tracker: 'jira', jiraTicketId: 'ENG-1234' } },
      registry,
    )
    expect(issues).toEqual([])
  })

  it('passes when the required scm plugin can be resolved', () => {
    const registry = new PluginRegistry()
    registry.register(fakeScm('github'))
    const issues = getJobPluginRequirementIssues({ params: { repoSlug: 'weather-service' } }, registry)
    expect(issues).toEqual([])
  })
})

describe('getIncomingPluginSelectionIssues', () => {
  it('rejects params.tracker when the plugin is not installed', () => {
    const issues = getIncomingPluginSelectionIssues({ tracker: 'jira' }, new PluginRegistry())
    expect(issues).toHaveLength(1)
    expect(issues[0]?.kind).toBe('tracker')
    expect(issues[0]?.message).toMatch(/Cannot set params\.tracker to "jira"/)
    expect(issues[0]?.message).toMatch(/Enable it in Settings > Tracker/)
    expect(issues[0]?.message).not.toMatch(/restart/)
  })

  it('rejects params.scm when the plugin is not installed', () => {
    const issues = getIncomingPluginSelectionIssues({ scm: 'gitlab' }, new PluginRegistry())
    expect(issues).toHaveLength(1)
    expect(issues[0]?.kind).toBe('scm')
    expect(issues[0]?.message).toMatch(/Cannot set params\.scm to "gitlab"/)
  })

  it('rejects trackerRef.pluginId when that tracker is not installed', () => {
    const issues = getIncomingPluginSelectionIssues(
      { trackerRef: { kind: 'ticket', pluginId: 'jira', externalId: 'WS-5539' } },
      new PluginRegistry(),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toMatch(/Cannot set params\.trackerRef\.pluginId to "jira"/)
  })

  it('does not double-report when tracker and trackerRef name the same missing plugin', () => {
    const issues = getIncomingPluginSelectionIssues(
      { tracker: 'jira', trackerRef: { pluginId: 'jira' } },
      new PluginRegistry(),
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toMatch(/params\.tracker/)
  })

  it('reports trackerRef separately when it names a different missing plugin', () => {
    const registry = new PluginRegistry()
    registry.register(fakeTracker('jira'))
    const issues = getIncomingPluginSelectionIssues(
      { tracker: 'jira', trackerRef: { pluginId: 'linear' } },
      registry,
    )
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toMatch(/params\.trackerRef\.pluginId to "linear"/)
  })

  it('allows setting an installed tracker and scm', () => {
    const registry = new PluginRegistry()
    registry.register(fakeScm('github'))
    registry.register(fakeTracker('jira'))
    expect(getIncomingPluginSelectionIssues(
      { scm: 'github', tracker: 'jira', trackerRef: { pluginId: 'jira' } },
      registry,
    )).toEqual([])
  })

  it('ignores empty plugin ids so a selection can be cleared', () => {
    expect(getIncomingPluginSelectionIssues(
      { tracker: '  ', scm: '', trackerRef: { pluginId: '' } },
      new PluginRegistry(),
    )).toEqual([])
  })

  it('does not inspect keys other than scm / tracker / trackerRef', () => {
    expect(getIncomingPluginSelectionIssues(
      { language: 'golang', jiraTicketId: 'WS-5539' },
      new PluginRegistry(),
    )).toEqual([])
  })

  it('rejects a plugin id registered as the wrong kind', () => {
    const registry = new PluginRegistry()
    registry.register(fakeScm('github'))
    const issues = getIncomingPluginSelectionIssues({ tracker: 'github' }, registry)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toMatch(/registered as kind "scm"/)
  })
})
