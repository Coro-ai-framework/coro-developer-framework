import { describe, it, expect } from 'vitest'
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  RPC_TIMEOUT_MS,
  RPC_MAX_RETRIES,
  LOG_BATCH_INTERVAL_MS,
} from '../../src/state/ws-protocol'

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
