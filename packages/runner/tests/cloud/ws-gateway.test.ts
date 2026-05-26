import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import pino from 'pino'
import { RunnerRegistry } from '../../src/cloud/ws/runner-registry'
import { WsGateway } from '../../src/cloud/ws/gateway'
import { signRunnerToken } from '../../src/cloud/auth/jwt'
import type { CloudConfig } from '../../src/cloud/config'
import type { CloudMessage } from '@coro-ai/cloud-protocol'

const logger = pino({ level: 'silent' })

const config: CloudConfig = {
  port: 0, // random port
  databaseUrl: 'postgresql://localhost/test',
  redisUrl: 'redis://localhost:6379',
  jwtSecret: 'test-secret-that-is-at-least-32-chars-long!',
  jwtIssuer: 'corolabs-test',
  jwtAccessTtlSeconds: 900,
  jwtRefreshTtlSeconds: 604800,
  logLevel: 'info',
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
}

function waitForMessage(ws: WebSocket): Promise<CloudMessage> {
  return new Promise((resolve) => {
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()))
    })
  })
}

describe('WsGateway', () => {
  let server: http.Server
  let gateway: WsGateway
  let registry: RunnerRegistry
  let port: number
  let runnerToken: string

  beforeEach(async () => {
    registry = new RunnerRegistry(logger)

    // We can't use a real DB for unit tests, but we can test the gateway
    // connection/auth/routing layer. Mock the DB at the gateway level.
    const mockDb = {} as never

    gateway = new WsGateway({ config, db: mockDb, logger, registry })

    server = http.createServer()
    gateway.attach(server)

    await new Promise<void>((resolve) => {
      server.listen(0, () => resolve())
    })
    port = (server.address() as { port: number }).port

    // Generate a valid runner token
    runnerToken = await signRunnerToken('token-1', 'team-1', config)
  })

  afterEach(async () => {
    gateway.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('rejects connections without a token', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/runner`)

    await new Promise<void>((resolve) => {
      ws.on('error', () => resolve())
      ws.on('close', () => resolve())
    })

    expect(ws.readyState).not.toBe(WebSocket.OPEN)
  })

  it('rejects connections to wrong path', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/wrong-path?token=${runnerToken}`)

    await new Promise<void>((resolve) => {
      ws.on('error', () => resolve())
      ws.on('close', () => resolve())
    })

    expect(ws.readyState).not.toBe(WebSocket.OPEN)
  })

  it('accepts connections with valid runner token', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/runner?token=${runnerToken}`)
    await waitForOpen(ws)

    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })

  it('registers runner after receiving runner:register message', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/runner?token=${runnerToken}`)
    await waitForOpen(ws)

    ws.send(JSON.stringify({
      type: 'runner:register',
      runnerId: 'runner-1',
      hostname: 'test-host',
    }))

    // Give it a moment to process
    await new Promise(resolve => setTimeout(resolve, 50))

    const runners = registry.getTeamRunners('team-1')
    expect(runners).toHaveLength(1)
    expect(runners[0].runnerId).toBe('runner-1')
    expect(runners[0].hostname).toBe('test-host')

    ws.close()
  })

  it('unregisters runner on disconnect', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/runner?token=${runnerToken}`)
    await waitForOpen(ws)

    ws.send(JSON.stringify({
      type: 'runner:register',
      runnerId: 'runner-1',
      hostname: 'test-host',
    }))
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(registry.getTeamRunners('team-1')).toHaveLength(1)

    ws.close()
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(registry.getTeamRunners('team-1')).toHaveLength(0)
  })

  it('delivers pending events on runner registration', async () => {
    // Queue an event before any runner connects
    const webhookEvent = {
      type: 'event:webhook' as const,
      event: {
        source: 'bitbucket' as const,
        eventKey: 'pr:comment:created',
        payload: { prId: 42 },
        receivedAt: new Date().toISOString(),
      },
    }
    registry.queueEvent('team-1', webhookEvent)

    const ws = new WebSocket(`ws://localhost:${port}/ws/runner?token=${runnerToken}`)
    await waitForOpen(ws)

    // Set up message listener before registering
    const msgPromise = waitForMessage(ws)

    ws.send(JSON.stringify({
      type: 'runner:register',
      runnerId: 'runner-1',
      hostname: 'test-host',
    }))

    const delivered = await msgPromise
    expect(delivered.type).toBe('event:webhook')

    ws.close()
  })

  it('forwards sendToTeam messages to connected runner', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/runner?token=${runnerToken}`)
    await waitForOpen(ws)

    ws.send(JSON.stringify({
      type: 'runner:register',
      runnerId: 'runner-1',
      hostname: 'test-host',
    }))
    await new Promise(resolve => setTimeout(resolve, 50))

    const msgPromise = waitForMessage(ws)
    const delivered = gateway.sendToTeam('team-1', {
      type: 'event:resume',
      jobId: 'job-1',
      prompt: 'Continue working',
    })

    expect(delivered).toBe(true)

    const msg = await msgPromise
    expect(msg.type).toBe('event:resume')

    ws.close()
  })

  it('queues sendToTeam messages when no runner connected', () => {
    const delivered = gateway.sendToTeam('team-1', {
      type: 'event:resume',
      jobId: 'job-1',
    })
    expect(delivered).toBe(false)
  })

  describe('sendToJobOrTeam', () => {
    it('routes via "job" when a runner reports the jobId in heartbeat', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/runner?token=${runnerToken}`)
      await waitForOpen(ws)

      ws.send(JSON.stringify({ type: 'runner:register', runnerId: 'runner-job', hostname: 'h1' }))
      await new Promise(resolve => setTimeout(resolve, 50))
      ws.send(JSON.stringify({
        type: 'runner:heartbeat',
        runnerId: 'runner-job',
        currentJobId: 'job-42',
        uptimeMs: 60000,
      }))
      await new Promise(resolve => setTimeout(resolve, 50))

      const msgPromise = waitForMessage(ws)
      const result = gateway.sendToJobOrTeam('team-1', 'job-42', {
        type: 'event:message',
        jobId: 'job-42',
        message: 'hello',
      })

      expect(result).toEqual({ delivered: true, route: 'job' })
      const msg = await msgPromise
      expect(msg.type).toBe('event:message')

      ws.close()
    })

    it('falls back to "team" when no runner claims the jobId but team has runners', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/runner?token=${runnerToken}`)
      await waitForOpen(ws)

      ws.send(JSON.stringify({ type: 'runner:register', runnerId: 'runner-idle', hostname: 'h2' }))
      // No heartbeat with currentJobId — runner is idle.
      await new Promise(resolve => setTimeout(resolve, 50))

      const msgPromise = waitForMessage(ws)
      const result = gateway.sendToJobOrTeam('team-1', 'job-99', {
        type: 'event:resume',
        jobId: 'job-99',
      })

      expect(result).toEqual({ delivered: true, route: 'team' })
      const msg = await msgPromise
      expect(msg.type).toBe('event:resume')

      ws.close()
    })

    it('returns "queued" when no runner is connected at all', () => {
      const result = gateway.sendToJobOrTeam('team-1', 'job-1', {
        type: 'event:message',
        jobId: 'job-1',
        message: 'queued',
      })
      expect(result).toEqual({ delivered: false, route: 'queued' })
    })
  })

  it('records heartbeat and updates runner status', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/runner?token=${runnerToken}`)
    await waitForOpen(ws)

    ws.send(JSON.stringify({
      type: 'runner:register',
      runnerId: 'runner-1',
      hostname: 'test-host',
    }))
    await new Promise(resolve => setTimeout(resolve, 50))

    ws.send(JSON.stringify({
      type: 'runner:heartbeat',
      runnerId: 'runner-1',
      currentJobId: 'job-42',
      uptimeMs: 60000,
    }))
    await new Promise(resolve => setTimeout(resolve, 50))

    const runner = registry.getRunner('team-1', 'runner-1')
    expect(runner?.status).toBe('busy')
    expect(runner?.currentJobId).toBe('job-42')

    ws.close()
  })
})
