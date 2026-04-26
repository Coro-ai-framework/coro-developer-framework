import type { EventTransport } from './transport'
import type { InboundEvent, OutboundEvent } from './events'

// ── In-process transport ──────────────────────────────────────────────────────
//
// Used in single-process deployments (local mode) where the HTTP server,
// dispatcher, and runner all live in the same process. Events flow
// synchronously through function calls — no network, no serialisation.
//
// The `onEvent` handler is registered by the Dispatcher at startup.
// `WebSocketTransport` is the cloud-mode counterpart that forwards events
// over the cloud control plane WebSocket.

export class InProcessTransport implements EventTransport {
  private handler?: (event: InboundEvent) => Promise<void>

  async connect(): Promise<void> { /* no-op */ }

  async disconnect(): Promise<void> { /* no-op */ }

  isConnected(): boolean { return true }

  onEvent(handler: (event: InboundEvent) => Promise<void>): void {
    this.handler = handler
  }

  async emit(_event: OutboundEvent): Promise<void> { /* no-op for in-process */ }

  /**
   * Deliver an event directly (for testing or in-process webhook routing).
   * Not part of the EventTransport interface — only available on the
   * concrete InProcessTransport when the caller has the concrete type.
   */
  async deliver(event: InboundEvent): Promise<void> {
    if (this.handler) {
      await this.handler(event)
    }
  }
}
