import { describe, expect, it, vi } from 'vitest'
import { healMcpTransport, isCoroMcpHealthy, runBoundedMcpHeal } from '../src/mcp-heal'

function makeQuery(opts: { status: string }) {
  return {
    setMcpServers: vi.fn(async () => ({ added: ['coro'], removed: [], errors: {} })),
    mcpServerStatus: vi.fn(async () => [{ name: 'coro', status: opts.status }]),
    reconnectMcpServer: vi.fn(async () => undefined),
  }
}

describe('healMcpTransport', () => {
  it('rebuilds servers before setMcpServers when rebuildServers is provided', async () => {
    const q = makeQuery({ status: 'connected' })
    const servers: Record<string, { type: string; name: string }> = {
      coro: { type: 'sdk', name: 'coro' },
    }
    let rebuildCalls = 0
    await healMcpTransport({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      liveQuery: q as any,
      dynamicMcpServers: servers as any,
      rebuildServers: () => {
        rebuildCalls += 1
        servers.coro = { type: 'sdk', name: 'coro-fresh' }
        return servers as any
      },
    })
    expect(rebuildCalls).toBe(1)
    expect(servers.coro.name).toBe('coro-fresh')
    expect(q.setMcpServers).toHaveBeenCalledWith(servers)
  })
})

describe('runBoundedMcpHeal', () => {
  it('retries until coro status is healthy', async () => {
    let statusCalls = 0
    const q = {
      setMcpServers: vi.fn(async () => ({ added: ['coro'], removed: [], errors: {} })),
      mcpServerStatus: vi.fn(async () => {
        statusCalls += 1
        return [{ name: 'coro', status: statusCalls >= 2 ? 'connected' : 'disconnected' }]
      }),
      reconnectMcpServer: vi.fn(async () => undefined),
    }
    const servers = { coro: { type: 'sdk', name: 'coro' } }
    const result = await runBoundedMcpHeal({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      liveQuery: q as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dynamicMcpServers: servers as any,
      timeoutMs: 2_000,
    })
    expect(isCoroMcpHealthy(result)).toBe(true)
    expect(q.setMcpServers.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('isCoroMcpHealthy', () => {
  it('accepts connected or null status with no set errors', () => {
    expect(
      isCoroMcpHealthy({
        setResult: { added: [], removed: [], errors: {} },
        initialStatus: 'connected',
        finalStatus: 'connected',
        reconnected: false,
      }),
    ).toBe(true)
    expect(
      isCoroMcpHealthy({
        setResult: { added: [], removed: [], errors: {} },
        initialStatus: null,
        finalStatus: null,
        reconnected: false,
      }),
    ).toBe(true)
  })

  it('rejects setMcpServers errors for coro', () => {
    expect(
      isCoroMcpHealthy({
        setResult: { added: [], removed: [], errors: { coro: 'bad' } },
        initialStatus: 'connected',
        finalStatus: 'connected',
        reconnected: false,
      }),
    ).toBe(false)
  })
})
