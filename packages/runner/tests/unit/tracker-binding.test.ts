import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import pino from 'pino'
import type { ExecutorMcpServerInfo } from '@coro-ai/plugin-sdk'
import { PluginRegistry } from '../../src/plugins/registry'
import { matchTrackerProfile } from '../../src/trackers/profiles'
import {
  mcpTrackerBinding,
  mcpTrackerRedirect,
  resolveTrackerBinding,
  type ResolveTrackerBindingArgs,
} from '../../src/trackers/binding'
import { getMcpInventory, resetMcpInventoryCache, type McpInventory } from '../../src/trackers/inventory'
import { resolveJobTracker } from '../../src/trackers/resolve-job'
import { computeTrackerPromptContext } from '../../src/prompt/builder'
import { getIncomingPluginSelectionIssues } from '../../src/jobs/plugin-preflight'
import { discoverClaudeCodePluginMcpServers } from '../../src/config/local-config'
import { createMcpToolHandlers } from '../../src/mcp-handlers'
import { makeMockToolContextWithSpies, makeStubTrackerPlugin } from '../mcp/fixtures'

const logger = pino({ level: 'silent' })

function atlassian(overrides: Partial<ExecutorMcpServerInfo> = {}): ExecutorMcpServerInfo {
  return {
    name: 'claude.ai Atlassian',
    toolPrefix: 'mcp__claude_ai_Atlassian__',
    status: 'connected',
    source: 'claudeai',
    url: 'https://mcp.atlassian.com/v1/mcp',
    tools: [
      { name: 'getJiraIssue', readOnly: true },
      { name: 'searchJiraIssuesUsingJql', readOnly: true },
      { name: 'addCommentToJiraIssue', readOnly: false },
      { name: 'transitionJiraIssue', readOnly: false },
      { name: 'getAccessibleAtlassianResources', readOnly: true },
      { name: 'somethingNew' },
    ],
    ...overrides,
  }
}

function linear(overrides: Partial<ExecutorMcpServerInfo> = {}): ExecutorMcpServerInfo {
  return {
    name: 'claude.ai Linear',
    toolPrefix: 'mcp__claude_ai_Linear__',
    status: 'connected',
    url: 'https://mcp.linear.app/mcp',
    tools: [],
    ...overrides,
  }
}

function github(): ExecutorMcpServerInfo {
  return {
    name: 'github',
    toolPrefix: 'mcp__github__',
    status: 'connected',
    tools: [{ name: 'issue_read' }, { name: 'add_issue_comment' }],
  }
}

function inventory(...servers: ExecutorMcpServerInfo[]): McpInventory {
  return { origin: 'executor', observedAt: new Date().toISOString(), servers }
}

function registryWith(...trackerIds: string[]): PluginRegistry {
  const r = new PluginRegistry()
  for (const id of trackerIds) r.register(makeStubTrackerPlugin(id).plugin)
  return r
}

function resolve(args: Partial<ResolveTrackerBindingArgs>) {
  return resolveTrackerBinding({ policyTracker: 'auto', registry: registryWith(), ...args })
}

describe('tracker profiles', () => {
  it('recognises the Atlassian connector by host and by tool names', () => {
    expect(matchTrackerProfile(atlassian())?.id).toBe('atlassian-rovo')
    expect(matchTrackerProfile(atlassian({ url: undefined }))?.id).toBe('atlassian-rovo')
    expect(matchTrackerProfile(atlassian({ tools: [], url: undefined }))).toBeUndefined()
  })

  it('recognises Linear and GitHub', () => {
    expect(matchTrackerProfile(linear())?.id).toBe('linear')
    expect(matchTrackerProfile(github())?.id).toBe('github')
  })
})

describe('mcpTrackerBinding', () => {
  it('qualifies tools with the server prefix and splits reads from writes', () => {
    const b = mcpTrackerBinding(atlassian(), matchTrackerProfile(atlassian()))
    expect(b.selector).toBe('mcp:claude.ai Atlassian')
    expect(b.provider).toBe('jira')
    expect(b.tools.getIssue).toBe('mcp__claude_ai_Atlassian__getJiraIssue')
    expect(b.readTools).toContain('mcp__claude_ai_Atlassian__getJiraIssue')
    expect(b.writeTools).toContain('mcp__claude_ai_Atlassian__addCommentToJiraIssue')
    // Unannotated, unknown tools are writes so plan mode cannot reach them.
    expect(b.writeTools).toContain('mcp__claude_ai_Atlassian__somethingNew')
  })

  it('falls back to the profile when the server lists no tools', () => {
    const b = mcpTrackerBinding(linear(), matchTrackerProfile(linear()))
    expect(b.readTools).toContain('mcp__claude_ai_Linear__get_issue')
    expect(b.writeTools).toContain('mcp__claude_ai_Linear__create_comment')
    // update_issue is both "transition" and "updateIssue" — a write either way.
    expect(b.readTools).not.toContain('mcp__claude_ai_Linear__update_issue')
  })
})

describe('resolveTrackerBinding', () => {
  it('binds nothing when the policy says none', () => {
    const r = resolve({ policyTracker: 'none', inventory: inventory(atlassian()) })
    expect(r.binding).toBeUndefined()
    expect(r.candidates).toHaveLength(1)
  })

  it('prefers a configured plugin over MCP servers in auto mode', () => {
    const r = resolve({ registry: registryWith('jira'), inventory: inventory(atlassian()) })
    expect(r.binding?.source).toBe('plugin')
    expect(r.binding?.id).toBe('jira')
  })

  it('binds the only connected tracker MCP server when no plugin is configured', () => {
    const r = resolve({ inventory: inventory(atlassian(), github()) })
    expect(r.binding?.selector).toBe('mcp:claude.ai Atlassian')
    expect(r.candidates.map(c => c.selector)).toContain('mcp:github')
  })

  it('never auto-selects a GitHub server, but binds it when pinned', () => {
    expect(resolve({ inventory: inventory(github()) }).binding).toBeUndefined()
    expect(resolve({ policyTracker: 'mcp:github', inventory: inventory(github()) }).binding?.provider).toBe('github-issues')
  })

  it('refuses to guess between two connected trackers', () => {
    const r = resolve({ inventory: inventory(atlassian(), linear()) })
    expect(r.binding).toBeUndefined()
    expect(r.reason).toMatch(/several tracker MCP servers/)
  })

  it('breaks the tie with the source ticket provider', () => {
    const r = resolve({ inventory: inventory(atlassian(), linear()), preferProvider: 'linear' })
    expect(r.binding?.id).toBe('claude.ai Linear')
  })

  it('reports a connector that needs authentication', () => {
    const r = resolve({ inventory: inventory(atlassian({ status: 'needs-auth' })) })
    expect(r.binding).toBeUndefined()
    expect(r.reason).toMatch(/needs-auth/)
  })

  it('matches a pinned server by its name or its tool-prefix id', () => {
    expect(resolve({ policyTracker: 'mcp:claude_ai_Atlassian', inventory: inventory(atlassian()) }).binding).toBeDefined()
    expect(resolve({ policyTracker: 'mcp:missing', inventory: inventory(atlassian()) }).reason).toMatch(/not attached/)
  })

  it('honours params.tracker before the plugin default', () => {
    const r = resolve({ registry: registryWith('jira'), jobTracker: 'mcp:claude.ai Atlassian', inventory: inventory(atlassian()) })
    expect(r.binding?.source).toBe('mcp')
  })
})

describe('mcpTrackerRedirect', () => {
  it('shapes Atlassian arguments and leaves unknowns as placeholders', () => {
    const b = mcpTrackerBinding(atlassian(), matchTrackerProfile(atlassian()))
    const r = mcpTrackerRedirect(b, 'comment', { key: 'WS-1', body: 'hi' })
    expect(r?.tool).toBe('mcp__claude_ai_Atlassian__addCommentToJiraIssue')
    expect(r?.args).toMatchObject({ cloudId: '<cloudId>', issueIdOrKey: 'WS-1', commentBody: 'hi' })
  })
})

describe('computeTrackerPromptContext with a resolution', () => {
  it('describes an MCP-backed tracker', () => {
    const resolution = resolve({ inventory: inventory(atlassian(), github()) })
    const ctx = computeTrackerPromptContext(registryWith(), resolution)
    expect(ctx).toMatchObject({ available: true, pluginId: 'mcp:claude.ai Atlassian', source: 'mcp', provider: 'jira' })
    expect(ctx.tools?.['comment']).toBe('mcp__claude_ai_Atlassian__addCommentToJiraIssue')
    expect(ctx.notes?.length).toBeGreaterThan(0)
    expect(ctx.candidates).toEqual([{ selector: 'mcp:github', status: 'connected' }])
  })

  it('says why there is no tracker', () => {
    const ctx = computeTrackerPromptContext(registryWith(), resolve({ inventory: inventory() }))
    expect(ctx).toMatchObject({ available: false, pluginId: 'none' })
    expect(ctx.reason).toMatch(/no tracker/)
  })
})

describe('getMcpInventory', () => {
  beforeEach(() => resetMcpInventoryCache())

  it('uses the configured servers when the executor cannot inspect', async () => {
    const inv = await getMcpInventory({
      executor: { manifest: { id: 'openai' } as never },
      pluginMcpServers: { atl: { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp' } as never },
      cwd: os.tmpdir(),
      logger,
    })
    expect(inv.origin).toBe('config')
    expect(inv.servers[0]).toMatchObject({ name: 'atl', status: 'unknown', url: 'https://mcp.atlassian.com/v1/mcp' })
  })

  it('caches a probe and shares it between concurrent callers', async () => {
    const inspectMcpServers = vi.fn().mockResolvedValue([atlassian()])
    const executor = { manifest: { id: 'anthropic' } as never, inspectMcpServers }
    const args = { executor, pluginMcpServers: {}, cwd: os.tmpdir(), logger }
    const [a, b] = await Promise.all([getMcpInventory(args), getMcpInventory(args)])
    await getMcpInventory(args)
    expect(inspectMcpServers).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    await getMcpInventory({ ...args, refresh: true })
    expect(inspectMcpServers).toHaveBeenCalledTimes(2)
  })

  it('does not cache an empty probe', async () => {
    const inspectMcpServers = vi.fn().mockResolvedValue([])
    const executor = { manifest: { id: 'anthropic' } as never, inspectMcpServers }
    const args = { executor, pluginMcpServers: {}, cwd: os.tmpdir(), logger }
    await getMcpInventory(args)
    await getMcpInventory(args)
    expect(inspectMcpServers).toHaveBeenCalledTimes(2)
  })
})

describe('resolveJobTracker', () => {
  beforeEach(() => resetMcpInventoryCache())

  it('does not probe when a plugin already answers', async () => {
    const inspectMcpServers = vi.fn().mockResolvedValue([atlassian()])
    const r = await resolveJobTracker({
      job: { params: {} },
      registry: registryWith('jira'),
      executor: { manifest: { id: 'anthropic' } as never, inspectMcpServers },
      pluginMcpServers: {},
      cwd: os.tmpdir(),
      logger,
    })
    expect(r.binding?.id).toBe('jira')
    expect(inspectMcpServers).not.toHaveBeenCalled()
  })

  it('probes and binds the connector when no plugin is configured', async () => {
    const inspectMcpServers = vi.fn().mockResolvedValue([atlassian()])
    const r = await resolveJobTracker({
      job: { params: { trackerRef: { kind: 'ticket', pluginId: 'jira', externalId: 'WS-1' } } },
      registry: registryWith(),
      executor: { manifest: { id: 'anthropic' } as never, inspectMcpServers },
      pluginMcpServers: {},
      cwd: os.tmpdir(),
      logger,
    })
    expect(r.binding?.selector).toBe('mcp:claude.ai Atlassian')
  })

  it('reads the tracker from the policy snapshot', async () => {
    const inspectMcpServers = vi.fn().mockResolvedValue([atlassian()])
    const r = await resolveJobTracker({
      job: { params: { ticketingPolicy: { tracker: 'none' } } },
      registry: registryWith(),
      executor: { manifest: { id: 'anthropic' } as never, inspectMcpServers },
      pluginMcpServers: {},
      cwd: os.tmpdir(),
      logger,
    })
    expect(r.binding).toBeUndefined()
    expect(inspectMcpServers).not.toHaveBeenCalled()
  })
})

describe('tracker_* handlers with an MCP binding', () => {
  it('redirect to the bound server instead of the plugin', async () => {
    const { ctx, trackerSpies } = makeMockToolContextWithSpies()
    ctx.trackerBinding = mcpTrackerBinding(atlassian(), matchTrackerProfile(atlassian()))
    const h = createMcpToolHandlers(ctx, {})
    const out = await h.tracker_transition_issue({ key: 'WS-1', status: 'In Progress' })
    const body = JSON.parse(out.content[0]!.text)
    expect(body.upstreamTool).toBe('mcp__claude_ai_Atlassian__transitionJiraIssue')
    expect(body.upstreamArgs.issueIdOrKey).toBe('WS-1')
    expect(trackerSpies['jira']!.transitionIssue).not.toHaveBeenCalled()
  })

  it('still reach the plugin when the call names it', async () => {
    const { ctx, trackerSpies } = makeMockToolContextWithSpies()
    ctx.trackerBinding = mcpTrackerBinding(atlassian(), matchTrackerProfile(atlassian()))
    const h = createMcpToolHandlers(ctx, {})
    await h.tracker_get_issue({ pluginId: 'jira', key: 'WS-1' })
    expect(trackerSpies['jira']!.getIssue).toHaveBeenCalledWith('WS-1')
  })
})

describe('plugin preflight', () => {
  it('accepts an MCP tracker selector without a plugin', () => {
    expect(getIncomingPluginSelectionIssues({ tracker: 'mcp:claude.ai Atlassian' }, new PluginRegistry())).toEqual([])
    expect(
      getIncomingPluginSelectionIssues(
        { trackerRef: { kind: 'ticket', pluginId: 'mcp:claude.ai Atlassian', externalId: 'WS-1' } },
        new PluginRegistry(),
      ),
    ).toEqual([])
  })
})

describe('discoverClaudeCodePluginMcpServers', () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-cc-plugins-'))
  })
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  function write(rel: string, data: unknown) {
    const file = path.join(home, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data))
  }

  it('reads MCP servers from enabled plugins only', () => {
    const atlRoot = path.join(home, '.claude/plugins/cache/official/atlassian/1.0.0')
    const toolRoot = path.join(home, '.claude/plugins/cache/acme/tool/2.0.0')
    const offRoot = path.join(home, '.claude/plugins/cache/acme/off/1.0.0')
    write('.claude/settings.json', {
      enabledPlugins: { 'atlassian@official': true, 'tool@acme': true, 'off@acme': false },
    })
    write('.claude/plugins/installed_plugins.json', {
      version: 2,
      plugins: {
        'atlassian@official': [{ scope: 'user', installPath: atlRoot }],
        'tool@acme': [{ scope: 'user', installPath: toolRoot }],
        'off@acme': [{ scope: 'user', installPath: offRoot }],
      },
    })
    write(path.relative(home, path.join(atlRoot, '.mcp.json')), {
      mcpServers: { atlassian: { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp' } },
    })
    write(path.relative(home, path.join(toolRoot, '.claude-plugin/plugin.json')), {
      name: 'tool',
      mcpServers: { srv: { command: '${CLAUDE_PLUGIN_ROOT}/bin/server', args: ['--root', '${CLAUDE_PLUGIN_ROOT}'] } },
    })
    write(path.relative(home, path.join(offRoot, '.mcp.json')), { x: { type: 'http', url: 'https://x' } })

    const { servers, sources } = discoverClaudeCodePluginMcpServers(home)
    expect(Object.keys(servers).sort()).toEqual(['plugin_atlassian_atlassian', 'plugin_tool_srv'])
    expect(servers['plugin_atlassian_atlassian']).toEqual({ type: 'http', url: 'https://mcp.atlassian.com/v1/mcp' })
    expect(servers['plugin_tool_srv']).toEqual({
      type: 'stdio',
      command: `${toolRoot}/bin/server`,
      args: ['--root', toolRoot],
    })
    expect(sources).toHaveLength(2)
  })

  it('returns nothing when no plugins are enabled', () => {
    expect(discoverClaudeCodePluginMcpServers(home)).toEqual({ servers: {}, sources: [] })
  })
})
