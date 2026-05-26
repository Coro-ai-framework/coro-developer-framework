import type { InboundEvent, OutboundEvent } from '@coro-ai/cloud-protocol'

// ── Event transport interface ─────────────────────────────────────────────────
//
// Abstracts how external events (webhooks, cloud messages) reach the runner
// and how the runner reports state back to the control plane.
//
// Implementations:
//   InProcessTransport   — direct in-process delivery (local mode)
//   WebSocketTransport   — cloud control plane relay (hybrid mode)
//   PollingTransport     — poll external APIs for events (local mode)

export interface EventTransport {

  /** Establish connection (e.g. WebSocket handshake). No-op for in-process. */
  connect(): Promise<void>

  /** Tear down connection. No-op for in-process. */
  disconnect(): Promise<void>

  /** Whether the transport is connected and ready to deliver events. */
  isConnected(): boolean

  /**
   * Register handler for inbound events (webhooks, cloud-forwarded events).
   * Only one handler is active at a time — subsequent calls replace the previous.
   */
  onEvent(handler: (event: InboundEvent) => Promise<void>): void

  /**
   * Emit an event from the runner to the control plane.
   * In-process: no-op. Cloud: sends via WebSocket.
   */
  emit(event: OutboundEvent): Promise<void>
}
