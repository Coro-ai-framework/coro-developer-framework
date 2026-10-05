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
})
