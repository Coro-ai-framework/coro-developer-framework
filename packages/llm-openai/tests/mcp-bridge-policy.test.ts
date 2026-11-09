import { describe, expect, it, vi } from 'vitest'
import { McpFunctionBridge } from '../src/mcp-bridge'

describe('McpFunctionBridge policy', () => {
  it('asks the hook before running an in-process tool', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
    const bridge = new McpFunctionBridge({
      coroServer: {
        kind: 'sdk-instance',
        id: 'coro',
        instance: {
          _registeredTools: {
            ping: { description: 'ping', handler },
          },
        },
      },
      pluginServers: {},
      cwd: '/tmp',
      hookPolicy: {
        allowedTools: null,
        writeRoots: ['/tmp'],
        onPreToolUse: async () => ({ allow: false, reason: 'ask first' }),
      },
    })

    const result = await bridge.call({ callId: 'c1', name: 'mcp__coro__ping', argumentsJson: '{}' })
    expect(result.item.output).toContain('ask first')
    expect(handler).not.toHaveBeenCalled()
  })

  it('honours wildcard allowlist entries for in-process tools', async () => {
    const allowedHandler = vi.fn(async () => ({ content: [{ type: 'text', text: 'context' }] }))
    const blockedHandler = vi.fn(async () => ({ content: [{ type: 'text', text: 'nope' }] }))
    const bridge = new McpFunctionBridge({
      coroServer: {
        kind: 'sdk-instance',
        id: 'coro',
        instance: {
          _registeredTools: {
            review_get_context: { description: 'context', handler: allowedHandler },
            propose_change: { description: 'propose', handler: blockedHandler },
          },
        },
      },
      pluginServers: {},
      cwd: '/tmp',
      phase: 'review',
      hookPolicy: {
        allowedTools: ['Read', 'mcp__coro__review_*', 'mcp__coro__log'],
        writeRoots: ['/tmp'],
      },
    })

    const allowed = await bridge.call({ callId: 'c1', name: 'mcp__coro__review_get_context', argumentsJson: '{}' })
    expect(allowed.item.output).toBe('context')
    expect(allowedHandler).toHaveBeenCalledOnce()

    const blocked = await bridge.call({ callId: 'c2', name: 'mcp__coro__propose_change', argumentsJson: '{}' })
    expect(blocked.item.output).toContain('Blocked mcp__coro__propose_change')
    expect(blockedHandler).not.toHaveBeenCalled()
  })
})
