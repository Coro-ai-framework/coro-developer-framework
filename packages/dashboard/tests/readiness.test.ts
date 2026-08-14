// ── Settings readiness ───────────────────────────────────────────────────────
//
// `evaluateReadiness` decides whether Home says "ready to run jobs" and which
// sections the wizard marks as needing setup. It has no UI of its own, so a
// wrong answer here shows up as a banner that never clears — which is exactly
// what happened to local mode: its config is `{}` by design, and the old
// "configured means at least one config key" rule made it permanently unready.

import { describe, expect, it } from 'vitest'
import { evaluateReadiness } from '../src/pages/Settings/readiness'
import type {
  PluginEntry,
  PluginsCatalogue,
  SettingsDraft,
} from '../src/pages/Settings/SettingsContext'

function makeDraft(overrides: Partial<SettingsDraft> = {}): SettingsDraft {
  return {
    llmDefaultProvider: '',
    llmAliases: {},
    pluginInstalled: {},
    pluginDefaultScm: '',
    pluginDefaultTracker: '',
    mcpServersText: '{}',
    inheritClaudeCodeMcps: false,
    intelligenceDir: '',
    intelligenceRemote: '',
    workingDir: '',
    guardrailsEnabled: true,
    guardrailRules: [],
    guardrailsRulesText: '[]',
    upstreamRepoUrl: '',
    upstreamForkOwner: '',
    upstreamToken: '',
    upstreamMaxIssuesPerRun: '',
    upstreamMaxCodeJobsPerRun: '',
    ...overrides,
  }
}

function makePlugin(
  id: string,
  kind: string,
  manifest: Partial<PluginEntry['manifest']> = {},
): PluginEntry {
  return {
    manifest: {
      id,
      kind,
      version: '1.0.0',
      displayName: id,
      hostCompatibility: '^1.0.0',
      capabilities: {},
      configSchema: { type: 'object' },
      ...manifest,
    },
    installed: true,
  }
}

// Mirrors the real manifests: local asks for nothing, GitHub requires a token,
// and the Anthropic executor is satisfied by a completed Claude login rather
// than by a form field.
const LOCAL_SCM = makePlugin('local', 'scm', {
  configSchema: { type: 'object', properties: {}, required: [] },
  authMethods: [{ kind: 'form', id: 'enable', label: 'Enable local mode', fields: [] }],
})

const GITHUB_SCM = makePlugin('github', 'scm', {
  configSchema: {
    type: 'object',
    properties: { owner: { type: 'string' }, token: { type: 'string' } },
    required: ['owner', 'token'],
  },
  authMethods: [
    {
      kind: 'form',
      id: 'manual',
      label: 'Personal access token',
      fields: [
        { key: 'owner', label: 'Owner', kind: 'text' },
        { key: 'token', label: 'Token', kind: 'secret' },
      ],
    },
  ],
})

const ANTHROPIC = makePlugin('anthropic', 'executor', {
  configSchema: {
    type: 'object',
    properties: { authMode: { type: 'string' } },
    required: ['authMode'],
  },
})

function catalogue(...plugins: PluginEntry[]): PluginsCatalogue {
  return { plugins, defaults: {}, webhookBaseUrl: null }
}

describe('evaluateReadiness', () => {
  it('reports ready for a fresh install running local mode with Claude signed in', () => {
    const summary = evaluateReadiness({
      draft: makeDraft({
        llmDefaultProvider: 'anthropic',
        pluginDefaultScm: 'local',
        pluginInstalled: {
          anthropic: { enabled: true, config: { authMode: 'claudeLogin' } },
          local: { enabled: true, config: {} },
        },
      }),
      pluginsCatalogue: catalogue(ANTHROPIC, LOCAL_SCM),
    })

    expect(summary.missingRequired).toEqual([])
    expect(summary.ready).toBe(true)
    expect(summary.byId['source-control'].status).toBe('ok')
    expect(summary.byId['llm-provider'].status).toBe('ok')
  })

  it('still asks for setup when the only SCM plugin has unfilled required fields', () => {
    const summary = evaluateReadiness({
      draft: makeDraft({
        llmDefaultProvider: 'anthropic',
        pluginInstalled: {
          anthropic: { enabled: true, config: { authMode: 'claudeLogin' } },
          github: { enabled: true, config: { owner: 'acme' } },
        },
      }),
      pluginsCatalogue: catalogue(ANTHROPIC, GITHUB_SCM),
    })

    expect(summary.ready).toBe(false)
    expect(summary.missingRequired).toContain('source-control')
  })

  it('does not count a disabled zero-field plugin as configured', () => {
    const summary = evaluateReadiness({
      draft: makeDraft({
        llmDefaultProvider: 'anthropic',
        pluginInstalled: {
          anthropic: { enabled: true, config: { authMode: 'claudeLogin' } },
          local: { enabled: false, config: {} },
        },
      }),
      pluginsCatalogue: catalogue(ANTHROPIC, LOCAL_SCM),
    })

    expect(summary.ready).toBe(false)
    expect(summary.missingRequired).toContain('source-control')
  })

  it('treats a tracker as optional when none is configured', () => {
    const summary = evaluateReadiness({
      draft: makeDraft({
        llmDefaultProvider: 'anthropic',
        pluginInstalled: {
          anthropic: { enabled: true, config: { authMode: 'claudeLogin' } },
          local: { enabled: true, config: {} },
        },
      }),
      pluginsCatalogue: catalogue(ANTHROPIC, LOCAL_SCM),
    })

    expect(summary.byId['issue-tracker'].status).toBe('optional')
    expect(summary.missingRequired).not.toContain('issue-tracker')
  })

  it('recognises local as an SCM id before the catalogue has loaded', () => {
    const summary = evaluateReadiness({
      draft: makeDraft({
        llmDefaultProvider: 'anthropic',
        pluginInstalled: {
          anthropic: { enabled: true, config: { authMode: 'claudeLogin' } },
          local: { enabled: true, config: { repoPath: '/tmp/x' } },
        },
      }),
      pluginsCatalogue: null,
    })

    expect(summary.byId['source-control'].status).toBe('ok')
  })
})
