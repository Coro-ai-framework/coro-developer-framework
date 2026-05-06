// Tests for S1 of the MCP-first pivot: PluginRuntime.mcpServer() →
// runJob's dynamicMcpServers attachment.
//
// We don't drive a real `query()` here. We exercise the pure helper
// (`collectPluginMcpServers`) and assert it gathers descriptors
// correctly, skips plugins that don't expose one, refuses reserved
// ids, applies tool policies, and survives plugin throws.

import { describe, it, expect, vi } from 'vitest'
import pino from 'pino'
import { z } from 'zod'
import {
  PluginRegistry,
  type PluginManifest,
  type PluginRuntime,
  type PluginMcpServerConfig,
} from '../../src/plugins'
import { collectPluginMcpServers } from '../../src/jobs/runner'

const logger = pino({ level: 'silent' })

function makeManifest(
  id: string,
  capabilities?: Record<string, boolean | ReadonlyArray<string>>,
): PluginManifest {
  return {
    id,
    kind: 'scm',
    version: '0.0.1',
    displayName: id,
    hostCompatibility: '*',
    configSchema: z.object({}),
    // The collector reads `allowedMcpTools` / `disallowedMcpTools` from
    // the capabilities bag — ergonomically typed as boolean above but
    // the runner deliberately tolerates arbitrary value shapes.
    capabilities: capabilities as Record<string, boolean> | undefined,
  }
}

function makeRuntime(
  id: string,
  mcpServer: (() => PluginMcpServerConfig | undefined) | null,
  capabilities?: Record<string, boolean | ReadonlyArray<string>>,
): PluginRuntime {
  const runtime: PluginRuntime = {
    manifest: makeManifest(id, capabilities),
    init: vi.fn().mockResolvedValue(undefined),
    healthcheck: vi.fn().mockResolvedValue({ ok: true }),
    dispose: vi.fn().mockResolvedValue(undefined),
  }
  if (mcpServer) runtime.mcpServer = mcpServer
  return runtime
}

function buildRegistry(runtimes: PluginRuntime[]): PluginRegistry {
  const reg = new PluginRegistry()
  for (const r of runtimes) reg.register(r)
  return reg
}

describe('collectPluginMcpServers', () => {
  it('collects descriptors from plugins that expose mcpServer()', () => {
    const reg = buildRegistry([
      makeRuntime('github', () => ({
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_xxx' },
      })),
      makeRuntime('jira', () => ({
        type: 'http',
        url: 'https://mcp.atlassian.com',
        headers: { Authorization: 'Bearer xxx' },
      })),
    ])

    const servers = collectPluginMcpServers({ plugins: reg, logger })
    expect(Object.keys(servers).sort()).toEqual(['github', 'jira'])
    expect(servers.github).toMatchObject({ type: 'stdio', command: 'npx' })
    expect(servers.jira).toMatchObject({ type: 'http', url: 'https://mcp.atlassian.com' })
  })

  it('skips plugins without an mcpServer() method', () => {
    const reg = buildRegistry([
      makeRuntime('bitbucket', null),
      makeRuntime('github', () => ({
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
      })),
    ])

    const servers = collectPluginMcpServers({ plugins: reg, logger })
    expect(Object.keys(servers)).toEqual(['github'])
    expect(servers).not.toHaveProperty('bitbucket')
  })

  it('skips plugins whose mcpServer() returns undefined', () => {
    const reg = buildRegistry([
      makeRuntime('toggleable', () => undefined),
    ])
    const servers = collectPluginMcpServers({ plugins: reg, logger })
    expect(servers).toEqual({})
  })

  it('refuses to shadow the reserved `coro` id', () => {
    const reg = buildRegistry([
      makeRuntime('coro', () => ({
        type: 'stdio',
        command: 'whatever',
      })),
    ])
    const servers = collectPluginMcpServers({ plugins: reg, logger })
    expect(servers).toEqual({})
  })

  it('does not throw when a plugin mcpServer() raises — that plugin is skipped', () => {
    const reg = buildRegistry([
      makeRuntime('flaky', () => {
        throw new Error('boom')
      }),
      makeRuntime('healthy', () => ({
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
      })),
    ])

    const servers = collectPluginMcpServers({ plugins: reg, logger })
    expect(Object.keys(servers)).toEqual(['healthy'])
  })

  it('translates allowedMcpTools / disallowedMcpTools into SDK tool policies for http/sse', () => {
    const reg = buildRegistry([
      makeRuntime(
        'github',
        () => ({
          type: 'http',
          url: 'https://example.invalid/mcp',
        }),
        {
          allowedMcpTools: ['create_pull_request', 'get_pull_request'] as ReadonlyArray<string>,
          disallowedMcpTools: ['delete_repository'] as ReadonlyArray<string>,
        },
      ),
    ])
    const servers = collectPluginMcpServers({ plugins: reg, logger })
    expect(servers.github).toMatchObject({
      type: 'http',
      url: 'https://example.invalid/mcp',
      tools: [
        { name: 'create_pull_request', permission_policy: 'always_allow' },
        { name: 'get_pull_request', permission_policy: 'always_allow' },
        { name: 'delete_repository', permission_policy: 'always_deny' },
      ],
    })
  })

  it('does not attach a tools array when no allowed/disallowed list is configured', () => {
    const reg = buildRegistry([
      makeRuntime('github', () => ({
        type: 'http',
        url: 'https://example.invalid/mcp',
      })),
    ])
    const servers = collectPluginMcpServers({ plugins: reg, logger })
    expect(servers.github).not.toHaveProperty('tools')
  })

  it('returns an empty record when no plugins declare mcpServer()', () => {
    const reg = buildRegistry([
      makeRuntime('p1', null),
      makeRuntime('p2', null),
    ])
    expect(collectPluginMcpServers({ plugins: reg, logger })).toEqual({})
  })
})
