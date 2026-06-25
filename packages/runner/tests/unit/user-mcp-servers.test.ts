// Tests for S8 of the MCP-first plugins pivot: bring-your-own (BYO)
// MCP servers from `~/.coro/config.json` → `mcpServers`.
//
// We exercise the pure helper (`collectUserMcpServers`) by stubbing
// the local-config loader. The helper is deliberately resilient to
// load errors; we verify it returns an empty record instead of
// throwing.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import pino from 'pino'
import { collectUserMcpServers, collectPlanModeMcpServers } from '../../src/jobs/runner'

const logger = pino({ level: 'silent' })

let tmpDir: string
let savedHome: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-byo-mcp-'))
  fs.mkdirSync(path.join(tmpDir, '.coro'), { recursive: true })
  savedHome = process.env['HOME']
  process.env['HOME'] = tmpDir
})

afterEach(() => {
  if (savedHome !== undefined) process.env['HOME'] = savedHome
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeConfig(config: unknown): void {
  fs.writeFileSync(
    path.join(tmpDir, '.coro', 'config.json'),
    JSON.stringify(config, null, 2),
  )
}

describe('collectUserMcpServers', () => {
  it('returns an empty record when no config exists', () => {
    expect(collectUserMcpServers({ logger })).toEqual({})
  })

  it('returns an empty record when mcpServers block is absent', () => {
    writeConfig({ anthropic: { method: 'apiKey', apiKey: 'sk-test' } })
    expect(collectUserMcpServers({ logger })).toEqual({})
  })

  it('attaches stdio servers with command/args/env', () => {
    writeConfig({
      anthropic: { method: 'apiKey', apiKey: 'sk-test' },
      mcpServers: {
        slack: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-slack'],
          env: { SLACK_BOT_TOKEN: 'xoxb-…' },
        },
      },
    })

    const servers = collectUserMcpServers({ logger })
    expect(servers).toHaveProperty('slack')
    expect(servers.slack).toMatchObject({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack'],
      env: { SLACK_BOT_TOKEN: 'xoxb-…' },
    })
  })

  it('attaches http servers with url/headers', () => {
    writeConfig({
      anthropic: { method: 'apiKey', apiKey: 'sk-test' },
      mcpServers: {
        sentry: {
          type: 'http',
          url: 'https://mcp.sentry.io',
          headers: { Authorization: 'Bearer xyz' },
        },
      },
    })

    const servers = collectUserMcpServers({ logger })
    expect(servers.sentry).toMatchObject({
      type: 'http',
      url: 'https://mcp.sentry.io',
      headers: { Authorization: 'Bearer xyz' },
    })
  })

  it('skips entries with enabled: false', () => {
    writeConfig({
      anthropic: { method: 'apiKey', apiKey: 'sk-test' },
      mcpServers: {
        sentry: {
          type: 'http',
          url: 'https://mcp.sentry.io',
          enabled: false,
        },
        slack: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-slack'],
        },
      },
    })

    const servers = collectUserMcpServers({ logger })
    expect(Object.keys(servers)).toEqual(['slack'])
  })

  it('refuses to shadow the reserved `coro` id', () => {
    writeConfig({
      anthropic: { method: 'apiKey', apiKey: 'sk-test' },
      mcpServers: {
        coro: {
          type: 'stdio',
          command: 'whatever',
        },
      },
    })

    const servers = collectUserMcpServers({ logger })
    expect(servers).toEqual({})
  })

  it('translates allowedTools/disallowedTools into SDK tool policies for http servers', () => {
    writeConfig({
      anthropic: { method: 'apiKey', apiKey: 'sk-test' },
      mcpServers: {
        sentry: {
          type: 'http',
          url: 'https://mcp.sentry.io',
          allowedTools: ['list_issues', 'get_issue'],
          disallowedTools: ['delete_issue'],
        },
      },
    })

    const servers = collectUserMcpServers({ logger })
    expect(servers.sentry).toMatchObject({
      type: 'http',
      tools: [
        { name: 'list_issues', permission_policy: 'always_allow' },
        { name: 'get_issue', permission_policy: 'always_allow' },
        { name: 'delete_issue', permission_policy: 'always_deny' },
      ],
    })
  })

  it('does not throw when the config is malformed — returns empty', () => {
    fs.writeFileSync(path.join(tmpDir, '.coro', 'config.json'), '{ not json')
    const warn = vi.spyOn(logger, 'warn')
    expect(collectUserMcpServers({ logger })).toEqual({})
    expect(warn).toHaveBeenCalled()
  })

  // ── S9: inheritClaudeCodeMcps ────────────────────────────────────────────

  it('inherits MCP entries from ~/.claude.json when inheritClaudeCodeMcps=true', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          notion: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@notion/mcp-server'],
            env: { NOTION_TOKEN: 'secret_xyz' },
          },
        },
      }),
    )
    writeConfig({
      anthropic: { method: 'apiKey', apiKey: 'sk-test' },
      inheritClaudeCodeMcps: true,
    })

    const servers = collectUserMcpServers({ logger })
    expect(servers).toHaveProperty('notion')
    expect(servers.notion).toMatchObject({ type: 'stdio', command: 'npx' })
  })

  it('does not inherit when inheritClaudeCodeMcps is false (default)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          notion: { type: 'stdio', command: 'npx', args: ['-y', '@notion/mcp-server'] },
        },
      }),
    )
    writeConfig({ anthropic: { method: 'apiKey', apiKey: 'sk-test' } })

    expect(collectUserMcpServers({ logger })).toEqual({})
  })

  it('explicit BYO entries override inherited Claude Code entries with the same id', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          slack: { type: 'stdio', command: 'broken-binary' },
        },
      }),
    )
    writeConfig({
      anthropic: { method: 'apiKey', apiKey: 'sk-test' },
      inheritClaudeCodeMcps: true,
      mcpServers: {
        slack: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-slack'],
        },
      },
    })

    const servers = collectUserMcpServers({ logger })
    expect(servers.slack).toMatchObject({
      type: 'stdio',
      command: 'npx',
    })
  })

  it('also inherits from ~/.claude/settings.json (later file wins)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          shared: { type: 'stdio', command: 'old', args: [] },
        },
      }),
    )
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          shared: { type: 'stdio', command: 'new', args: ['updated'] },
          extra: { type: 'http', url: 'https://mcp.example.com' },
        },
      }),
    )
    writeConfig({
      anthropic: { method: 'apiKey', apiKey: 'sk-test' },
      inheritClaudeCodeMcps: true,
    })

    const servers = collectUserMcpServers({ logger })
    expect(servers.shared).toMatchObject({ command: 'new' })
    expect(servers.extra).toMatchObject({ type: 'http', url: 'https://mcp.example.com' })
  })

  it('treats Claude Code stdio entries without explicit `type` as stdio', () => {
    // Claude Code's own writer often omits `type` when adding stdio
    // servers; we infer it from the presence of `command`.
    fs.writeFileSync(
      path.join(tmpDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          'shape-shift': {
            command: 'npx',
            args: ['-y', '@example/server'],
          },
        },
      }),
    )
    writeConfig({
      anthropic: { method: 'apiKey', apiKey: 'sk-test' },
      inheritClaudeCodeMcps: true,
    })

    const servers = collectUserMcpServers({ logger })
    expect(servers['shape-shift']).toMatchObject({ type: 'stdio', command: 'npx' })
  })

  it('collectPlanModeMcpServers returns only entries with planMode: true', () => {
    writeConfig({
      anthropic: { method: 'apiKey', apiKey: 'sk-test' },
      mcpServers: {
        catalog: {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          planMode: true,
        },
        slack: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-slack'],
        },
        disabled: {
          type: 'stdio',
          command: 'node',
          args: ['off.js'],
          planMode: true,
          enabled: false,
        },
      },
    })

    const servers = collectPlanModeMcpServers({ logger })
    expect(Object.keys(servers)).toEqual(['catalog'])
    expect(servers.catalog).toMatchObject({ type: 'stdio', command: 'node' })
  })

  it('planModeOnly filter still applies when inheriting Claude Code servers', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          inherited: { type: 'stdio', command: 'node', args: ['inherited.js'] },
        },
      }),
    )
    writeConfig({
      anthropic: { method: 'apiKey', apiKey: 'sk-test' },
      inheritClaudeCodeMcps: true,
      mcpServers: {
        inherited: { type: 'stdio', command: 'node', args: ['inherited.js'], planMode: true },
      },
    })

    expect(Object.keys(collectUserMcpServers({ logger }))).toEqual(['inherited'])
    expect(Object.keys(collectPlanModeMcpServers({ logger }))).toEqual(['inherited'])
  })
})
