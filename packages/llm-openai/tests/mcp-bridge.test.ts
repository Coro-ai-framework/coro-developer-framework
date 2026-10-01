import { describe, it, expect } from 'vitest'
import { tool, createSdkMcpServer } from '@coro-ai/plugin-sdk'
import { z } from 'zod'
import { McpFunctionBridge } from '../src/mcp-bridge'

/**
 * Mirrors the `jsonArg` helper in `packages/runner/src/mcp-server.ts` —
 * a `z.preprocess` that JSON.parses a string argument before validating
 * it against the wrapped schema. Coro tools register array/object/record
 * parameters wrapped this way; the bridge must not bypass it.
 */
function jsonArg<T extends z.ZodTypeAny>(schema: T): z.ZodType<z.infer<T>> {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }, schema)
}

function makeBridge(tools: ReturnType<typeof tool>[]) {
  const coroServer = createSdkMcpServer({ name: 'coro', tools })
  return new McpFunctionBridge({
    coroServer: { kind: 'sdk-instance', id: 'coro', instance: coroServer.instance },
    pluginServers: {},
    hookPolicy: { allowedTools: null, writeRoots: [] },
    cwd: '/tmp',
  })
}

function call(name: string, args: Record<string, unknown>) {
  return { callId: 'call-1', name, argumentsJson: JSON.stringify(args) }
}

describe('McpFunctionBridge — jsonArg coercion (SDK tools)', () => {
  it('passes the coerced value (not the raw JSON string) to the handler', async () => {
    let received: unknown
    const setWorkItems = tool(
      'set_work_items',
      'desc',
      { workItems: jsonArg(z.array(z.string())) },
      async (args) => {
        received = args
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    )
    const bridge = makeBridge([setWorkItems])

    const result = await bridge.call(call('mcp__coro__set_work_items', { workItems: '["a","b"]' }))

    expect(result.item.output).toBe('ok')
    // The regression this guards: without threading the validated value
    // through, `received` would be `{ workItems: '["a","b"]' }` — the
    // literal string — because the bridge calls the handler directly
    // and previously discarded what `safeParse` coerced.
    expect(received).toEqual({ workItems: ['a', 'b'] })
  })

  it('reports the coerced value on the tool_call event and to policy, not the raw string', async () => {
    const seenByPolicy: unknown[] = []
    const setWorkItems = tool(
      'set_work_items',
      'desc',
      { workItems: jsonArg(z.array(z.string())) },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    )
    const coroServer = createSdkMcpServer({ name: 'coro', tools: [setWorkItems] })
    const bridge = new McpFunctionBridge({
      coroServer: { kind: 'sdk-instance', id: 'coro', instance: coroServer.instance },
      pluginServers: {},
      hookPolicy: {
        allowedTools: null,
        writeRoots: [],
        onPreToolUse: (_name, input) => {
          seenByPolicy.push(input)
          return { allow: true }
        },
      },
      cwd: '/tmp',
    })

    const result = await bridge.call(call('mcp__coro__set_work_items', { workItems: '["a","b"]' }))

    expect(seenByPolicy).toEqual([{ workItems: ['a', 'b'] }])
    const toolCallEvent = result.events.find(e => e.type === 'tool_call')
    expect(toolCallEvent).toMatchObject({ input: { workItems: ['a', 'b'] } })
  })

  it('still rejects an argument that is invalid JSON with the existing tool error', async () => {
    const setWorkItems = tool(
      'set_work_items',
      'desc',
      { workItems: jsonArg(z.array(z.string())) },
      async () => ({ content: [{ type: 'text', text: 'should not run' }] }),
    )
    const bridge = makeBridge([setWorkItems])

    const result = await bridge.call(call('mcp__coro__set_work_items', { workItems: 'not json' }))

    expect(result.item.output).toContain('Invalid arguments for mcp__coro__set_work_items')
    expect(result.events[0]).toMatchObject({ isError: true })
  })

  it('advertises the array shape for a jsonArg-wrapped parameter, not an empty fallback schema', async () => {
    const setWorkItems = tool(
      'set_work_items',
      'desc',
      { workItems: jsonArg(z.array(z.string())) },
      async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    )
    const bridge = makeBridge([setWorkItems])

    const [advertised] = bridge.listTools()

    // The regression this guards: `z.toJSONSchema` failing to represent
    // the `z.preprocess` pipe would make `toJsonSchema()`'s catch-all
    // fall back to `{ properties: {} }`, hiding the parameter from the
    // model entirely.
    expect(advertised.parameters).toMatchObject({
      properties: { workItems: { type: 'array', items: { type: 'string' } } },
    })
  })
})
