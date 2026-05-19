// SPDX-License-Identifier: LicenseRef-Coro-Commercial-1.0

// ── Runner registry ───────────────────────────────────────────────────────────
//
// Tracks which runners are connected per team. Used by the WebSocket gateway
// to route events (webhooks, resume commands) to the correct runner.

import WebSocket from 'ws'
import { Logger } from 'pino'
import { HEARTBEAT_TIMEOUT_MS } from '@coro/cloud-protocol'

export interface RunnerInfo {
  runnerId: string
  teamId: string
  hostname: string
  capabilities: string[]
  ws: WebSocket
  connectedAt: Date
  lastHeartbeat: Date
  currentJobId?: string
  status: 'idle' | 'busy' | 'offline'
}

/** Serializable runner info for API responses (no WebSocket handle). */
export interface RunnerInfoPublic {
  runnerId: string
  hostname: string
  connectedAt: string
  lastHeartbeat: string
  currentJobId?: string
  status: 'idle' | 'busy' | 'offline'
}

export class RunnerRegistry {
  /** Map<teamId, Map<runnerId, RunnerInfo>> */
  private runners = new Map<string, Map<string, RunnerInfo>>()
  private heartbeatTimer?: ReturnType<typeof setInterval>

  constructor(private logger: Logger) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start the heartbeat sweep timer. Marks runners offline if no heartbeat
   * received within HEARTBEAT_TIMEOUT_MS.
   */
  start(): void {
    this.heartbeatTimer = setInterval(() => this.sweepStale(), HEARTBEAT_TIMEOUT_MS / 2)
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  // ── Registration ───────────────────────────────────────────────────────────

  register(teamId: string, runnerId: string, hostname: string, ws: WebSocket, capabilities: string[] = []): RunnerInfo {
    let teamMap = this.runners.get(teamId)
    if (!teamMap) {
      teamMap = new Map()
      this.runners.set(teamId, teamMap)
    }

    // If the same runnerId reconnects, replace the old entry
    const existing = teamMap.get(runnerId)
    if (existing && existing.ws !== ws) {
      this.logger.info({ teamId, runnerId }, 'Runner reconnected — replacing old connection')
      try { existing.ws.close(1000, 'replaced') } catch { /* ignore */ }
    }

    const now = new Date()
    const info: RunnerInfo = {
      runnerId,
      teamId,
      hostname,
      capabilities,
      ws,
      connectedAt: now,
      lastHeartbeat: now,
      status: 'idle',
    }

    teamMap.set(runnerId, info)
    this.logger.info({ teamId, runnerId, hostname }, 'Runner registered')
    return info
  }

  unregister(teamId: string, runnerId: string): void {
    const teamMap = this.runners.get(teamId)
    if (!teamMap) return

    teamMap.delete(runnerId)
    if (teamMap.size === 0) {
      this.runners.delete(teamId)
    }
    this.logger.info({ teamId, runnerId }, 'Runner unregistered')
  }

  /** Remove a runner by its WebSocket reference (e.g. on disconnect). */
  unregisterByWs(ws: WebSocket): RunnerInfo | undefined {
    for (const [teamId, teamMap] of this.runners) {
      for (const [runnerId, info] of teamMap) {
        if (info.ws === ws) {
          teamMap.delete(runnerId)
          if (teamMap.size === 0) this.runners.delete(teamId)
          this.logger.info({ teamId, runnerId }, 'Runner disconnected')
          return info
        }
      }
    }
    return undefined
  }

  // ── Lookups ────────────────────────────────────────────────────────────────

  /** Get all runners for a team. */
  getTeamRunners(teamId: string): RunnerInfo[] {
    const teamMap = this.runners.get(teamId)
    return teamMap ? Array.from(teamMap.values()) : []
  }

  /** Get a specific runner. */
  getRunner(teamId: string, runnerId: string): RunnerInfo | undefined {
    return this.runners.get(teamId)?.get(runnerId)
  }

  /** Find the runner handling a specific job. */
  getRunnerByJob(jobId: string): RunnerInfo | undefined {
    for (const teamMap of this.runners.values()) {
      for (const info of teamMap.values()) {
        if (info.currentJobId === jobId) return info
      }
    }
    return undefined
  }

  /** Get serializable info for all runners on a team. */
  getTeamRunnersPublic(teamId: string): RunnerInfoPublic[] {
    return this.getTeamRunners(teamId).map(r => ({
      runnerId: r.runnerId,
      hostname: r.hostname,
      connectedAt: r.connectedAt.toISOString(),
      lastHeartbeat: r.lastHeartbeat.toISOString(),
      currentJobId: r.currentJobId,
      status: r.status,
    }))
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────

  recordHeartbeat(teamId: string, runnerId: string, currentJobId?: string): void {
    const info = this.getRunner(teamId, runnerId)
    if (!info) return

    info.lastHeartbeat = new Date()
    info.currentJobId = currentJobId
    info.status = currentJobId ? 'busy' : 'idle'
  }

  /** Sweep all runners, marking those with stale heartbeats as offline. */
  private sweepStale(): void {
    const threshold = Date.now() - HEARTBEAT_TIMEOUT_MS
    for (const teamMap of this.runners.values()) {
      for (const info of teamMap.values()) {
        if (info.lastHeartbeat.getTime() < threshold && info.status !== 'offline') {
          this.logger.warn({ teamId: info.teamId, runnerId: info.runnerId }, 'Runner heartbeat timed out — marking offline')
          info.status = 'offline'
        }
      }
    }
  }

  // ── Pending events ─────────────────────────────────────────────────────────
  //
  // When a webhook arrives for a team with no connected runner, the event is
  // queued here and delivered on reconnect.

  private pendingEvents = new Map<string, Array<{ event: unknown; queuedAt: Date }>>()

  /** Queue an event for delivery when a runner reconnects. Key = teamId. */
  queueEvent(teamId: string, event: unknown): void {
    let queue = this.pendingEvents.get(teamId)
    if (!queue) {
      queue = []
      this.pendingEvents.set(teamId, queue)
    }
    queue.push({ event, queuedAt: new Date() })
    this.logger.info({ teamId, queueLength: queue.length }, 'Event queued for offline team')
  }

  /** Drain all pending events for a team (called on runner reconnect). */
  drainPendingEvents(teamId: string): unknown[] {
    const queue = this.pendingEvents.get(teamId)
    if (!queue || queue.length === 0) return []

    const events = queue.map(q => q.event)
    this.pendingEvents.delete(teamId)
    this.logger.info({ teamId, count: events.length }, 'Delivering queued events to reconnected runner')
    return events
  }
}
