import { describe, expect, it } from 'vitest'
import { isMcpTransportErrorText, isRecoverableSteeringAbort } from '../src/steering-errors'

describe('isRecoverableSteeringAbort', () => {
  it('matches ede_diagnostic payloads', () => {
    expect(
      isRecoverableSteeringAbort(
        new Error('[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'),
      ),
    ).toBe(true)
  })

  it('matches request aborted', () => {
    expect(isRecoverableSteeringAbort(new Error('Error: Request was aborted.'))).toBe(true)
  })

  it('rejects unrelated errors', () => {
    expect(isRecoverableSteeringAbort(new Error('connection reset'))).toBe(false)
  })
})

describe('isMcpTransportErrorText', () => {
  it('detects stream closed', () => {
    expect(isMcpTransportErrorText('MCP error: Stream closed')).toBe(true)
  })

  it('rejects benign tool errors', () => {
    expect(isMcpTransportErrorText('file not found')).toBe(false)
  })
})
