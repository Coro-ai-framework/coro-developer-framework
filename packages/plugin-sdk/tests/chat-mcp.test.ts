import { describe, it, expect } from 'vitest'
import {
  buildChatToolAllowPolicy,
  chatHasTools,
  chatPluginMcpServerIds,
  isPlanModeMcpToolName,
  parseMcpToolName,
} from '../src/chat-mcp'
import type { ChatRequest } from '../src/types'

describe('chat-mcp helpers', () => {
  it('chatHasTools is true for built-in or plugin MCP', () => {
    expect(chatHasTools({ messages: [], model: 'm', signal: new AbortController().signal })).toBe(false)
    expect(chatHasTools({
      messages: [],
      model: 'm',
      signal: new AbortController().signal,
      tools: [{ name: 'scm_read_file', description: '', inputSchema: {} }],
      runTool: async () => ({}),
    })).toBe(true)
    expect(chatHasTools({
      messages: [],
      model: 'm',
      signal: new AbortController().signal,
      pluginMcpServers: { catalog: { type: 'stdio', command: 'node' } },
    })).toBe(true)
  })

  it('buildChatToolAllowPolicy allows coro and plan-mode MCP prefixes', async () => {
    const req: ChatRequest = {
      messages: [],
      model: 'm',
      signal: new AbortController().signal,
      tools: [{ name: 'tracker_get_issue', description: '', inputSchema: {} }],
      runTool: async () => ({}),
      pluginMcpServers: { catalog: { type: 'stdio', command: 'node' } },
    }
    const policy = buildChatToolAllowPolicy(req)
    expect(policy.checkToolAllowed('mcp__coro__tracker_get_issue').allow).toBe(true)
    expect(policy.checkToolAllowed('mcp__catalog__search').allow).toBe(true)
    expect(policy.checkToolAllowed('mcp__slack__post').allow).toBe(false)
    expect(policy.checkToolAllowed('ToolSearch').allow).toBe(true)
    expect(policy.hookAllowedTools).toBe(null)
    await expect(policy.decideToolCall('Bash', {})).resolves.toEqual({
      allow: false,
      reason: 'Blocked Bash: only plan-mode lookup tools are available.',
    })
  })

  it('decideToolCall sends non-builtin tools to permissionGate', async () => {
    const seen: string[] = []
    const req: ChatRequest = {
      messages: [],
      model: 'm',
      signal: new AbortController().signal,
      tools: [{ name: 'tracker_get_issue', description: '', inputSchema: {} }],
      runTool: async () => ({}),
      permissionGate: async (toolName) => {
        seen.push(toolName)
        return { allow: toolName === 'Bash', reason: 'no' }
      },
    }
    const policy = buildChatToolAllowPolicy(req)
    await expect(policy.decideToolCall('ToolSearch', {})).resolves.toEqual({ allow: true })
    await expect(policy.decideToolCall('mcp__coro__tracker_get_issue', {})).resolves.toEqual({ allow: true })
    await expect(policy.decideToolCall('Bash', { command: 'ls' })).resolves.toEqual({ allow: true, reason: 'no' })
    expect(seen).toEqual(['Bash'])
  })

  it('allows BYO MCP when built-in intake tools are also present', () => {
    const req: ChatRequest = {
      messages: [],
      model: 'm',
      signal: new AbortController().signal,
      tools: [
        { name: 'tracker_get_issue', description: '', inputSchema: {} },
        { name: 'scm_list_files', description: '', inputSchema: {} },
      ],
      runTool: async () => ({}),
      pluginMcpServers: { 'a5-be-catalog': { type: 'stdio', command: 'node' } },
    }
    const policy = buildChatToolAllowPolicy(req)
    expect(policy.checkToolAllowed('mcp__a5-be-catalog__find_callers').allow).toBe(true)
    expect(policy.checkToolAllowed('mcp__coro__scm_list_files').allow).toBe(true)
    expect(policy.checkToolAllowed('Bash').allow).toBe(false)
  })

  it('allows claude.ai connector tools attached by the Claude Code subprocess', () => {
    const req: ChatRequest = {
      messages: [],
      model: 'm',
      signal: new AbortController().signal,
      tools: [{ name: 'tracker_get_issue', description: '', inputSchema: {} }],
      runTool: async () => ({}),
    }
    const policy = buildChatToolAllowPolicy(req)
    expect(policy.checkToolAllowed('mcp__claude_ai_Atlassian__getJiraIssue').allow).toBe(true)
    expect(policy.checkToolAllowed('mcp__claude_ai_Linear__list_issues').allow).toBe(true)
    expect(policy.checkToolAllowed('mcp__slack__post').allow).toBe(false)
  })

  it('parseMcpToolName splits server and tool', () => {
    expect(parseMcpToolName('mcp__catalog__find_callers')).toEqual({
      serverId: 'catalog',
      toolName: 'find_callers',
    })
    expect(isPlanModeMcpToolName('mcp__catalog__search', chatPluginMcpServerIds({
      messages: [],
      model: 'm',
      signal: new AbortController().signal,
      pluginMcpServers: { catalog: { type: 'stdio', command: 'node' } },
    }))).toBe(true)
  })
})
