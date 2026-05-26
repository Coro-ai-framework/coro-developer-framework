// ── State layer — public API ──────────────────────────────────────────────────

export type { StateBackend } from './backend'
export type { EventTransport } from './transport'
export type { InboundEvent, OutboundEvent } from '@coro-ai/cloud-protocol'
export { RedisStateBackend } from './redis-backend'
export { InProcessTransport } from './in-process-transport'
export { SqliteStateBackend } from './sqlite-backend'
export { PollingTransport } from './polling-transport'
