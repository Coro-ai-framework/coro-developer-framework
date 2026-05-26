import { describe, it, expect } from 'vitest'
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  RPC_TIMEOUT_MS,
  RPC_MAX_RETRIES,
  LOG_BATCH_INTERVAL_MS,
} from '@coro-ai/cloud-protocol'
import type { WsJobUpdate } from '@coro-ai/cloud-protocol'

describe('ws-protocol constants', () => {
  it('heartbeat timeout > heartbeat interval', () => {
    expect(HEARTBEAT_TIMEOUT_MS).toBeGreaterThan(HEARTBEAT_INTERVAL_MS)
  })

  it('RPC timeout is reasonable', () => {
    expect(RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(5000)
    expect(RPC_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })

  it('retries are between 1 and 5', () => {
    expect(RPC_MAX_RETRIES).toBeGreaterThanOrEqual(1)
    expect(RPC_MAX_RETRIES).toBeLessThanOrEqual(5)
  })

  it('log batch interval is small', () => {
    expect(LOG_BATCH_INTERVAL_MS).toBeLessThanOrEqual(1000)
  })
})

describe('WsJobUpdate (Phase 8.1)', () => {
  it('carries conversationHistory in the patch additively', () => {
    // Compile-time + runtime check: the patch must accept the
    // stateless-executor history blob without a cast. JSON round-trip
    // verifies the shape stays plain-data so the gateway can ship it
    // straight to PostgresStateBackend.updateJob.
    const msg: WsJobUpdate = {
      type: 'job:update',
      messageId: 'm1',
      jobId: 'job-1',
      patch: {
        sessionId: 'sess-1',
        conversationHistory: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      },
    }
    const round = JSON.parse(JSON.stringify(msg)) as WsJobUpdate
    expect(round.patch.conversationHistory).toHaveLength(2)
    expect(round.patch.conversationHistory?.[0]?.role).toBe('user')
  })

  it('older runners that omit conversationHistory still parse', () => {
    const msg: WsJobUpdate = {
      type: 'job:update',
      messageId: 'm2',
      jobId: 'job-2',
      patch: { sessionId: 'sess-only' },
    }
    expect(msg.patch.conversationHistory).toBeUndefined()
  })
})
