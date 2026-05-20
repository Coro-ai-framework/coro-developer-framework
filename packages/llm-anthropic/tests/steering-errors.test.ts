import { describe, expect, it } from 'vitest'
import {
  isMcpHealExhaustedError,
  isMcpTransportErrorText,
  isRecoverableSteeringAbort,
  isSteeringDiagnosticText,
} from '../src/steering-errors'

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

describe('isSteeringDiagnosticText', () => {
  it('matches ede_diagnostic with null stop_reason', () => {
    expect(
      isSteeringDiagnosticText(
        '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null',
      ),
    ).toBe(true)
  })
})

describe('isMcpTransportErrorText', () => {
  it('detects stream closed', () => {
    expect(isMcpTransportErrorText('MCP error: Stream closed')).toBe(true)
  })

  it('detects process transport not ready', () => {
    expect(isMcpTransportErrorText('ProcessTransport is not ready for writing')).toBe(true)
  })

  it('rejects benign tool errors', () => {
    expect(isMcpTransportErrorText('file not found')).toBe(false)
  })
})

describe('isMcpHealExhaustedError', () => {
  it('detects rate limit and dead transport', () => {
    expect(isMcpHealExhaustedError("You've hit your limit · resets 1am")).toBe(true)
    expect(isMcpHealExhaustedError('ProcessTransport is not ready for writing')).toBe(true)
  })
})
