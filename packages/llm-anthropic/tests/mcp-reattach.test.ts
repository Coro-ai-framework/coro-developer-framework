import { describe, expect, it, vi } from 'vitest'
import { reattachDynamicMcpServers } from '../src/mcp-reattach'

function makeQuery(opts: {
  status: string
  setErrors?: Record<string, unknown>
  reconnectThrows?: boolean
}) {
  return {
    setMcpServers: vi.fn(async () => ({
      added: ['coro'],
      removed: [],
      errors: opts.setErrors ?? {},
    })),
    mcpServerStatus: vi.fn(async () => [{ name: 'coro', status: opts.status }]),
    reconnectMcpServer: vi.fn(async () => {
      if (opts.reconnectThrows) throw new Error('reconnect failed')
    }),
  }
}

describe('reattachDynamicMcpServers', () => {
  it('skips reconnect when status=connected and forceReconnect not requested', async () => {
    const q = makeQuery({ status: 'connected' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await reattachDynamicMcpServers(q as any, { coro: {} as any }, 'coro')
    expect(r.reconnected).toBe(false)
    expect(q.reconnectMcpServer).not.toHaveBeenCalled()
  })

  it('forces reconnect when forceReconnect=true even if status=connected', async () => {
    const q = makeQuery({ status: 'connected' })
    const r = await reattachDynamicMcpServers(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { coro: {} as any },
      'coro',
      { forceReconnect: true },
    )
    expect(r.reconnected).toBe(true)
    expect(q.reconnectMcpServer).toHaveBeenCalledWith('coro')
  })

  it('reconnects when status is not connected', async () => {
    const q = makeQuery({ status: 'disconnected' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await reattachDynamicMcpServers(q as any, { coro: {} as any }, 'coro')
    expect(r.reconnected).toBe(true)
    expect(q.reconnectMcpServer).toHaveBeenCalled()
  })

  it('does not reconnect when setMcpServers reports errors for the server', async () => {
    const q = makeQuery({ status: 'disconnected', setErrors: { coro: 'bad' } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await reattachDynamicMcpServers(q as any, { coro: {} as any }, 'coro')
    expect(r.reconnected).toBe(false)
    expect(q.reconnectMcpServer).not.toHaveBeenCalled()
  })

  it('swallows reconnect throws and still returns final status', async () => {
    const q = makeQuery({ status: 'connected', reconnectThrows: true })
    const r = await reattachDynamicMcpServers(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { coro: {} as any },
      'coro',
      { forceReconnect: true },
    )
    // reconnected stays false because the call threw before we could
    // mark it true.
    expect(r.reconnected).toBe(false)
    expect(r.finalStatus).toBe('connected')
    // …but the error message is now surfaced in `reconnectError` so
    // callers no longer think MCP is healthy after a silent failure.
    expect(r.reconnectError).toBe('reconnect failed')
  })

  it('retries reconnect once when the first attempt throws', async () => {
    let calls = 0
    const q = {
      setMcpServers: vi.fn(async () => ({ added: ['coro'], removed: [], errors: {} })),
      mcpServerStatus: vi.fn(async () => [{ name: 'coro', status: 'connected' }]),
      reconnectMcpServer: vi.fn(async () => {
        calls += 1
        if (calls === 1) throw new Error('transient race')
      }),
    }
    const r = await reattachDynamicMcpServers(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { coro: {} as any },
      'coro',
      { forceReconnect: true },
    )
    expect(calls).toBe(2)
    expect(r.reconnected).toBe(true)
    expect(r.reconnectError).toBeUndefined()
  })

  it('skips reconnectMcpServer for SDK-type (in-process) servers even with forceReconnect=true', async () => {
    // Regression: the Anthropic SDK rejects `reconnectMcpServer` for
    // in-process SDK servers with the literal error
    // "SDK servers should be handled in print.ts". Calling it produced
    // a constant false-positive `reconnectError` that broke the
    // auto-recovery steering nudge gate in executor.ts. SDK servers
    // have no transport; `setMcpServers` is the entire reattach
    // surface.
    const q = makeQuery({ status: 'connected' })
    const r = await reattachDynamicMcpServers(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      q as any,
      // SDK-type server config carries `type: 'sdk'`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { coro: { type: 'sdk', name: 'coro', instance: {} } as any },
      'coro',
      { forceReconnect: true },
    )
    expect(q.reconnectMcpServer).not.toHaveBeenCalled()
    expect(r.reconnected).toBe(false)
    expect(r.reconnectError).toBeUndefined()
    expect(r.finalStatus).toBe('connected')
    // setMcpServers must still run — it is the reattach for SDK servers.
    expect(q.setMcpServers).toHaveBeenCalled()
  })
})
