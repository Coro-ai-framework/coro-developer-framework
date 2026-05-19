// ── WebSocket transport (runner side) ─────────────────────────────────────────
//
// Implements EventTransport for hybrid mode. Maintains a persistent WebSocket
// connection to the cloud control plane with auto-reconnect and heartbeat.

import WebSocket from 'ws'
import crypto from 'crypto'
import os from 'os'
import { Logger } from 'pino'
import type { EventTransport } from './transport'
import type { InboundEvent, OutboundEvent } from '@coro/cloud-protocol'
import type {
  RunnerMessage,
  CloudMessage,
  WsRpcResponse,
} from '@coro/cloud-protocol'
import {
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  RPC_TIMEOUT_MS,
  RPC_MAX_RETRIES,
  LOG_BATCH_INTERVAL_MS,
} from '@coro/cloud-protocol'

export interface WsTransportConfig {
  /** Cloud WebSocket URL, e.g. wss://api.corolabs.com/ws/runner */
  url: string
  /** Runner JWT token for authentication */
  token: string
  /** Optional runner ID (auto-generated if not provided) */
  runnerId?: string
  /** Logger instance */
  logger: Logger
  /**
   * Translate a generic plugin webhook frame into a fully-formed
   * {@link InboundEvent}. The hybrid bootstrap supplies this with a
   * closure that has the {@link PluginRegistry}: it resolves the
   * plugin by id, calls `normalizeInbound`, and packages the result.
   *
   * The transport itself stays plugin-unaware — when no normalizer
   * is wired (e.g. a runner without any installed plugins) we log
   * and drop the frame instead of crashing the WS connection.
   */
  normalizePluginWebhook?: (
    pluginId: string,
    headers: Record<string, string>,
    rawBody: Buffer,
  ) => InboundEvent | null
}

interface PendingRpc {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class WebSocketTransport implements EventTransport {
  private ws: WebSocket | null = null
  private config: WsTransportConfig
  private runnerId: string
  private connected = false
  private shouldReconnect = true
  private reconnectAttempts = 0
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private logBatchTimer?: ReturnType<typeof setTimeout>

  private eventHandler?: (event: InboundEvent) => Promise<void>
  private pendingRpcs = new Map<string, PendingRpc>()
  private logBuffer = new Map<string, string[]>()

  constructor(config: WsTransportConfig) {
    this.config = config
    this.runnerId = config.runnerId ?? `runner-${crypto.randomUUID().slice(0, 8)}`
  }

  // ── EventTransport interface ───────────────────────────────────────────────

  async connect(): Promise<void> {
    this.shouldReconnect = true
    return this.doConnect()
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false
    this.flushLogs()
    this.cleanup()
    if (this.ws) {
      this.ws.close(1000, 'client disconnect')
      this.ws = null
    }
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  onEvent(handler: (event: InboundEvent) => Promise<void>): void {
    this.eventHandler = handler
  }

  async emit(event: OutboundEvent): Promise<void> {
    switch (event.type) {
      case 'job:log':
        this.bufferLog(event.jobId, event.data['line'] as string)
        return
      case 'job:update':
        await this.rpc({
          type: 'job:update',
          messageId: this.newMessageId(),
          jobId: event.jobId,
          patch: event.data as Record<string, unknown>,
        })
        return
      case 'job:complete':
        this.sendFire({ type: 'job:complete', jobId: event.jobId })
        return
      case 'job:park':
        this.sendFire({
          type: 'job:park',
          jobId: event.jobId,
          awaitedEvent: event.data['awaitedEvent'] as string,
        })
        return
      case 'runner:heartbeat':
        this.sendFire({
          type: 'runner:heartbeat',
          runnerId: this.runnerId,
          currentJobId: event.data['currentJobId'] as string | undefined,
          uptimeMs: event.data['uptimeMs'] as number,
        })
        return
    }
  }

  // ── RPC ────────────────────────────────────────────────────────────────────

  /**
   * Send an RPC message and wait for the response. Retries on timeout.
   */
  async rpc(msg: RunnerMessage & { messageId: string }, retries = RPC_MAX_RETRIES): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected')
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(msg.messageId)
        if (retries > 0) {
          this.config.logger.warn({ messageId: msg.messageId, type: msg.type, retriesLeft: retries - 1 },
            'RPC timeout — retrying')
          this.rpc(msg, retries - 1).then(resolve, reject)
        } else {
          reject(new Error(`RPC timeout for ${msg.type} (messageId: ${msg.messageId})`))
        }
      }, RPC_TIMEOUT_MS)

      this.pendingRpcs.set(msg.messageId, { resolve, reject, timer })
      this.ws!.send(JSON.stringify(msg))
    })
  }

  /** Generate a unique message ID for RPC correlation. */
  newMessageId(): string {
    return crypto.randomUUID()
  }

  // ── Log batching ───────────────────────────────────────────────────────────

  private bufferLog(jobId: string, line: string): void {
    let buf = this.logBuffer.get(jobId)
    if (!buf) {
      buf = []
      this.logBuffer.set(jobId, buf)
    }
    buf.push(line)

    if (!this.logBatchTimer) {
      this.logBatchTimer = setTimeout(() => this.flushLogs(), LOG_BATCH_INTERVAL_MS)
    }
  }

  private flushLogs(): void {
    if (this.logBatchTimer) {
      clearTimeout(this.logBatchTimer)
      this.logBatchTimer = undefined
    }

    for (const [jobId, lines] of this.logBuffer) {
      if (lines.length > 0) {
        this.sendFire({ type: 'job:log', jobId, lines })
      }
    }
    this.logBuffer.clear()
  }

  // ── Connection management ──────────────────────────────────────────────────

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.config.url}?token=${this.config.token}`
      this.ws = new WebSocket(url)

      const onOpen = () => {
        this.connected = true
        this.reconnectAttempts = 0
        this.config.logger.info({ runnerId: this.runnerId }, 'WebSocket connected to cloud')

        // Send registration
        this.sendFire({
          type: 'runner:register',
          runnerId: this.runnerId,
          hostname: os.hostname(),
          protocolVersion: PROTOCOL_VERSION,
        })

        // Start heartbeat
        this.heartbeatTimer = setInterval(() => {
          this.sendFire({
            type: 'runner:heartbeat',
            runnerId: this.runnerId,
            uptimeMs: process.uptime() * 1000,
          })
        }, HEARTBEAT_INTERVAL_MS)

        // Start log flushing
        resolve()
      }

      const onError = (err: Error) => {
        this.config.logger.error({ err }, 'WebSocket connection error')
        if (!this.connected) reject(err)
      }

      const onClose = () => {
        this.connected = false
        this.cleanup()
        if (this.shouldReconnect) {
          this.scheduleReconnect()
        }
      }

      const onMessage = (raw: WebSocket.RawData) => {
        this.handleCloudMessage(raw)
      }

      this.ws.once('open', onOpen)
      this.ws.on('error', onError)
      this.ws.on('close', onClose)
      this.ws.on('message', onMessage)
    })
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000)
    this.reconnectAttempts++
    this.config.logger.info({ delay, attempt: this.reconnectAttempts }, 'Scheduling reconnect')

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.doConnect()
      } catch {
        // doConnect rejection triggers onClose → scheduleReconnect
      }
    }, delay)
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    // Reject all pending RPCs
    for (const [, pending] of this.pendingRpcs) {
      clearTimeout(pending.timer)
      pending.reject(new Error('WebSocket disconnected'))
    }
    this.pendingRpcs.clear()
  }

  // ── Incoming message handling ──────────────────────────────────────────────

  private handleCloudMessage(raw: WebSocket.RawData): void {
    let msg: CloudMessage
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      this.config.logger.warn('Received invalid JSON from cloud')
      return
    }

    switch (msg.type) {
      case 'rpc:response':
        this.handleRpcResponse(msg)
        return

      case 'event:webhook':
        if (this.eventHandler) {
          this.eventHandler(msg.event).catch(err => {
            this.config.logger.error({ err }, 'Error handling webhook event')
          })
        }
        return

      case 'event:pluginWebhook': {
        if (!this.eventHandler) return
        const normalize = this.config.normalizePluginWebhook
        if (!normalize) {
          this.config.logger.warn(
            { pluginId: msg.pluginId },
            'Plugin webhook received but no normalizer wired — dropping',
          )
          return
        }
        let event: InboundEvent | null
        try {
          event = normalize(
            msg.pluginId,
            msg.headers,
            Buffer.from(msg.rawBodyBase64, 'base64'),
          )
        } catch (err) {
          this.config.logger.error(
            { err, pluginId: msg.pluginId },
            'Plugin webhook normalisation threw',
          )
          return
        }
        if (!event) {
          this.config.logger.debug(
            { pluginId: msg.pluginId },
            'Plugin returned null from normalizeInbound — skipping',
          )
          return
        }
        this.eventHandler(event).catch(err => {
          this.config.logger.error(
            { err, pluginId: msg.pluginId },
            'Error handling plugin webhook event',
          )
        })
        return
      }

      case 'event:resume':
        if (this.eventHandler) {
          this.eventHandler({
            source: 'cloud',
            eventKey: 'job:resume',
            payload: { jobId: msg.jobId, prompt: msg.prompt },
            receivedAt: new Date().toISOString(),
          }).catch(err => {
            this.config.logger.error({ err }, 'Error handling resume event')
          })
        }
        return

      case 'event:cancel':
        if (this.eventHandler) {
          this.eventHandler({
            source: 'cloud',
            eventKey: 'job:cancel',
            payload: { jobId: msg.jobId, reason: msg.reason },
            receivedAt: new Date().toISOString(),
          }).catch(err => {
            this.config.logger.error({ err }, 'Error handling cancel event')
          })
        }
        return

      case 'event:pause':
        if (this.eventHandler) {
          this.eventHandler({
            source: 'cloud',
            eventKey: 'job:pause',
            payload: { jobId: msg.jobId, reason: msg.reason },
            receivedAt: new Date().toISOString(),
          }).catch(err => {
            this.config.logger.error({ err }, 'Error handling pause event')
          })
        }
        return

      case 'event:message':
        if (this.eventHandler) {
          this.eventHandler({
            source: 'cloud',
            eventKey: 'job:message',
            payload: { jobId: msg.jobId, message: msg.message },
            receivedAt: new Date().toISOString(),
          }).catch(err => {
            this.config.logger.error({ err }, 'Error handling message event')
          })
        }
        return

      case 'proposal:apply':
        if (this.eventHandler) {
          this.eventHandler({
            source: 'cloud',
            eventKey: 'proposal:apply',
            payload: { proposalId: msg.proposalId, files: msg.files },
            receivedAt: new Date().toISOString(),
          }).catch(err => {
            this.config.logger.error({ err }, 'Error handling proposal apply')
          })
        }
        return

      case 'event:dispatch':
        if (this.eventHandler) {
          this.eventHandler({
            source: 'cloud',
            eventKey: 'job:dispatch',
            payload: { jobId: msg.jobId },
            receivedAt: new Date().toISOString(),
          }).catch(err => {
            this.config.logger.error({ err }, 'Error handling job dispatch')
          })
        }
        return

      case 'runner:ping':
        // Respond with a heartbeat
        this.sendFire({
          type: 'runner:heartbeat',
          runnerId: this.runnerId,
          uptimeMs: process.uptime() * 1000,
        })
        return
    }
  }

  private handleRpcResponse(msg: WsRpcResponse): void {
    const pending = this.pendingRpcs.get(msg.messageId)
    if (!pending) {
      this.config.logger.warn({ messageId: msg.messageId }, 'Received response for unknown RPC')
      return
    }

    clearTimeout(pending.timer)
    this.pendingRpcs.delete(msg.messageId)

    if (msg.ok) {
      pending.resolve(msg.data)
    } else {
      pending.reject(new Error(msg.error ?? 'RPC failed'))
    }
  }

  // ── Send helpers ───────────────────────────────────────────────────────────

  /** Send a fire-and-forget message (no response expected). */
  private sendFire(msg: RunnerMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }
}
