import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'http'
import { WebSocketServer } from 'ws'
import pino from 'pino'
import { WebSocketTransport } from '../../src/state/ws-transport'
import type { RunnerMessage } from '../../src/state/ws-protocol'

const logger = pino({ level: 'silent' })

describe('WebSocketTransport', () => {
  let server: http.Server
  let wss: WebSocketServer
  let port: number

  beforeEach(async () => {
    server = http.createServer()
    wss = new WebSocketServer({ server })

    wss.on('connection', (_ws) => {
    })

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as { port: number }).port
        resolve()
      })
    })
  })

  afterEach(async () => {
    wss.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('connects and sends registration message', async () => {
    const transport = new WebSocketTransport({
      url: `ws://localhost:${port}`,
      token: 'test-token',
      runnerId: 'test-runner',
      logger,
    })

    const regPromise = new Promise<RunnerMessage>((resolve) => {
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'runner:register') resolve(msg)
        })
      })
    })

    await transport.connect()
    expect(transport.isConnected()).toBe(true)

    const reg = await regPromise
    expect(reg.type).toBe('runner:register')
    if (reg.type === 'runner:register') {
      expect(reg.runnerId).toBe('test-runner')
    }

    await transport.disconnect()
  })

  it('handles RPC request/response', async () => {
    // Set up server to echo back RPC responses
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.messageId) {
          ws.send(JSON.stringify({
            type: 'rpc:response',
            messageId: msg.messageId,
            ok: true,
            data: { echo: msg.type },
          }))
        }
      })
    })

    const transport = new WebSocketTransport({
      url: `ws://localhost:${port}`,
      token: 'test-token',
      runnerId: 'rpc-test',
      logger,
    })

    await transport.connect()

    const messageId = transport.newMessageId()
    const result = await transport.rpc({
      type: 'job:get',
      messageId,
      jobId: 'job-1',
    })

    expect(result).toEqual({ echo: 'job:get' })

    await transport.disconnect()
  })

  it('forwards inbound events to handler', async () => {
    const transport = new WebSocketTransport({
      url: `ws://localhost:${port}`,
      token: 'test-token',
      runnerId: 'event-test',
      logger,
    })

    const received: unknown[] = []
    transport.onEvent(async (event) => {
      received.push(event)
    })

    await transport.connect()

    // Wait for server to have the connection
    await new Promise(resolve => setTimeout(resolve, 50))

    // Server sends a webhook event
    for (const client of wss.clients) {
      client.send(JSON.stringify({
        type: 'event:webhook',
        event: {
          source: 'bitbucket',
          eventKey: 'pr:comment:created',
          payload: { prId: 42 },
          receivedAt: new Date().toISOString(),
        },
      }))
    }

    await new Promise(resolve => setTimeout(resolve, 100))

    expect(received).toHaveLength(1)
    expect((received[0] as { source: string }).source).toBe('bitbucket')

    await transport.disconnect()
  })

  it('responds to ping with heartbeat', async () => {
    const heartbeatPromise = new Promise<RunnerMessage>((resolve) => {
      wss.on('connection', (ws) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'runner:heartbeat') resolve(msg)
        })
      })
    })

    const transport = new WebSocketTransport({
      url: `ws://localhost:${port}`,
      token: 'test-token',
      runnerId: 'ping-test',
      logger,
    })

    await transport.connect()
    await new Promise(resolve => setTimeout(resolve, 50))

    // Server sends ping
    for (const client of wss.clients) {
      client.send(JSON.stringify({ type: 'runner:ping' }))
    }

    const hb = await heartbeatPromise
    expect(hb.type).toBe('runner:heartbeat')
    if (hb.type === 'runner:heartbeat') {
      expect(hb.runnerId).toBe('ping-test')
    }

    await transport.disconnect()
  })

  it('batches log messages', async () => {
    const logMessages: RunnerMessage[] = []
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'job:log') logMessages.push(msg)
      })
    })

    const transport = new WebSocketTransport({
      url: `ws://localhost:${port}`,
      token: 'test-token',
      runnerId: 'log-test',
      logger,
    })

    await transport.connect()
    await new Promise(resolve => setTimeout(resolve, 50))

    // Emit multiple log lines rapidly
    await transport.emit({ type: 'job:log', jobId: 'job-1', data: { line: 'line 1' } })
    await transport.emit({ type: 'job:log', jobId: 'job-1', data: { line: 'line 2' } })
    await transport.emit({ type: 'job:log', jobId: 'job-1', data: { line: 'line 3' } })

    // Wait for batch interval
    await new Promise(resolve => setTimeout(resolve, 200))

    // Should have sent as a single batched message
    expect(logMessages.length).toBeGreaterThanOrEqual(1)
    const totalLines = logMessages.reduce((sum, m) => {
      if (m.type === 'job:log') return sum + m.lines.length
      return sum
    }, 0)
    expect(totalLines).toBe(3)

    await transport.disconnect()
  })

  it('isConnected returns false after disconnect', async () => {
    const transport = new WebSocketTransport({
      url: `ws://localhost:${port}`,
      token: 'test-token',
      runnerId: 'disconnect-test',
      logger,
    })

    await transport.connect()
    expect(transport.isConnected()).toBe(true)

    await transport.disconnect()
    expect(transport.isConnected()).toBe(false)
  })
})
