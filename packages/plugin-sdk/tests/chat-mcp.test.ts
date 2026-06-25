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

  it('buildChatToolAllowPolicy allows coro and plan-mode MCP prefixes', () => {
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
