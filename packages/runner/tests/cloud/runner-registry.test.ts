import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import pino from 'pino'
import WebSocket from 'ws'
import { RunnerRegistry } from '../../src/cloud/ws/runner-registry'

const logger = pino({ level: 'silent' })

function mockWs(readyState = WebSocket.OPEN): WebSocket {
  return {
    readyState,
    close: vi.fn(),
    send: vi.fn(),
  } as unknown as WebSocket
}

describe('RunnerRegistry', () => {
  let registry: RunnerRegistry

  beforeEach(() => {
    registry = new RunnerRegistry(logger)
  })

  afterEach(() => {
    registry.stop()
  })

  describe('register / unregister', () => {
    it('registers a runner for a team', () => {
      const ws = mockWs()
      registry.register('team-1', 'runner-a', 'dev-laptop', ws)

      const runners = registry.getTeamRunners('team-1')
      expect(runners).toHaveLength(1)
      expect(runners[0].runnerId).toBe('runner-a')
      expect(runners[0].hostname).toBe('dev-laptop')
      expect(runners[0].status).toBe('idle')
    })

    it('replaces existing runner with same ID on reconnect', () => {
      const ws1 = mockWs()
      const ws2 = mockWs()

      registry.register('team-1', 'runner-a', 'dev-laptop', ws1)
      registry.register('team-1', 'runner-a', 'dev-laptop', ws2)

      const runners = registry.getTeamRunners('team-1')
      expect(runners).toHaveLength(1)
      expect(runners[0].ws).toBe(ws2)
      expect(ws1.close).toHaveBeenCalledWith(1000, 'replaced')
    })

    it('unregisters by runnerId', () => {
      const ws = mockWs()
      registry.register('team-1', 'runner-a', 'dev-laptop', ws)
      registry.unregister('team-1', 'runner-a')

      expect(registry.getTeamRunners('team-1')).toHaveLength(0)
    })

    it('unregisters by WebSocket reference', () => {
      const ws = mockWs()
      registry.register('team-1', 'runner-a', 'dev-laptop', ws)

      const info = registry.unregisterByWs(ws)
      expect(info?.runnerId).toBe('runner-a')
      expect(registry.getTeamRunners('team-1')).toHaveLength(0)
    })

    it('returns undefined when unregistering unknown WebSocket', () => {
      const ws = mockWs()
      expect(registry.unregisterByWs(ws)).toBeUndefined()
    })
  })

  describe('lookups', () => {
    it('finds runner by job ID', () => {
      const ws = mockWs()
      registry.register('team-1', 'runner-a', 'dev-laptop', ws)
      registry.recordHeartbeat('team-1', 'runner-a', 'job-123')

      const found = registry.getRunnerByJob('job-123')
      expect(found?.runnerId).toBe('runner-a')
    })

    it('returns undefined for unknown job', () => {
      expect(registry.getRunnerByJob('nonexistent')).toBeUndefined()
    })

    it('returns public runner info without WebSocket handle', () => {
      const ws = mockWs()
      registry.register('team-1', 'runner-a', 'dev-laptop', ws)

      const pubs = registry.getTeamRunnersPublic('team-1')
      expect(pubs).toHaveLength(1)
      expect(pubs[0]).not.toHaveProperty('ws')
      expect(pubs[0].runnerId).toBe('runner-a')
      expect(pubs[0].connectedAt).toBeDefined()
    })
  })

  describe('heartbeat', () => {
    it('updates status to busy when job is reported', () => {
      const ws = mockWs()
      registry.register('team-1', 'runner-a', 'dev-laptop', ws)

      registry.recordHeartbeat('team-1', 'runner-a', 'job-1')
      const runner = registry.getRunner('team-1', 'runner-a')
      expect(runner?.status).toBe('busy')
      expect(runner?.currentJobId).toBe('job-1')
    })

    it('updates status to idle when no job is reported', () => {
      const ws = mockWs()
      registry.register('team-1', 'runner-a', 'dev-laptop', ws)
      registry.recordHeartbeat('team-1', 'runner-a', 'job-1')
      registry.recordHeartbeat('team-1', 'runner-a', undefined)

      const runner = registry.getRunner('team-1', 'runner-a')
      expect(runner?.status).toBe('idle')
    })
  })

  describe('pending events', () => {
    it('queues and drains events', () => {
      registry.queueEvent('team-1', { type: 'event:webhook', data: 'test' })
      registry.queueEvent('team-1', { type: 'event:webhook', data: 'test2' })

      const events = registry.drainPendingEvents('team-1')
      expect(events).toHaveLength(2)

      // Draining again returns empty
      const again = registry.drainPendingEvents('team-1')
      expect(again).toHaveLength(0)
    })

    it('returns empty for team with no queued events', () => {
      expect(registry.drainPendingEvents('unknown-team')).toHaveLength(0)
    })
  })
})
