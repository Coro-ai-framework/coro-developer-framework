import { describe, expect, it } from 'vitest'
import {
  isBunSourceFrameLine,
  isMcpHealExhaustedError,
  isMcpInputDeadText,
  isMcpTransportErrorText,
  isMidPhaseStopReason,
  isRecoverableSteeringAbort,
  isSteeringDiagnosticText,
  shouldClosePushableAfterResult,
} from '../src/steering-errors'

describe('isBunSourceFrameLine', () => {
  it('matches Bun-style minified SDK source frames', () => {
    expect(
      isBunSourceFrameLine(
        '9158 | `)}async sendRequest(H,_,q,K=Pw6.randomUUID()){let O={type:"control_request",request_id:K,request:H};if(this.inputClosed)throw Error("Stream closed");if(q?.aborted)throw Error("Request aborted")',
      ),
    ).toBe(true)
    expect(isBunSourceFrameLine('42 | foo()')).toBe(true)
  })

  it('rejects ordinary stderr lines', () => {
    expect(isBunSourceFrameLine('Stream closed')).toBe(false)
    expect(isBunSourceFrameLine('MCP error: Stream closed')).toBe(false)
    expect(isBunSourceFrameLine('control_request failed with reason X')).toBe(false)
  })
})

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

  it('rejects parallel Bash cancellation that mentions mcp__coro__ in the command', () => {
    expect(
      isMcpTransportErrorText(
        '<tool_use_error>Cancelled: parallel tool call Bash(mcp__coro__log "Checking PR") errored</tool_use_error>',
      ),
    ).toBe(false)
  })

  it('still detects real MCP transport failures inside tool_use_error wrappers', () => {
    expect(isMcpTransportErrorText('<tool_use_error>MCP error: Stream closed</tool_use_error>')).toBe(
      true,
    )
  })
})

describe('shouldClosePushableAfterResult', () => {
  it('matches original behavior: close on empty buffer unless mid-phase', () => {
    expect(shouldClosePushableAfterResult('end_turn')).toBe(true)
    expect(shouldClosePushableAfterResult('max_turns')).toBe(true)
    expect(shouldClosePushableAfterResult('max_tokens')).toBe(true)
    expect(shouldClosePushableAfterResult('stop_sequence')).toBe(true)
    expect(shouldClosePushableAfterResult('refusal')).toBe(true)
    expect(shouldClosePushableAfterResult('error')).toBe(true)
    // Unknown values close too — same as pre-steering-fix default.
    expect(shouldClosePushableAfterResult('some_future_reason')).toBe(true)
  })

  it('keeps pushable open for steering and in-flight tool rounds', () => {
    expect(isMidPhaseStopReason('interrupted')).toBe(true)
    expect(isMidPhaseStopReason('tool_use')).toBe(true)
    expect(isMidPhaseStopReason('pause_turn')).toBe(true)
    expect(shouldClosePushableAfterResult('interrupted')).toBe(false)
    expect(shouldClosePushableAfterResult('tool_use')).toBe(false)
    expect(shouldClosePushableAfterResult('pause_turn')).toBe(false)
  })
})

describe('isMcpInputDeadText', () => {
  it('detects closed control stream', () => {
    expect(isMcpInputDeadText('if(this.inputClosed)throw Error("Stream closed")')).toBe(true)
    expect(isMcpInputDeadText('Stream closed')).toBe(true)
  })
})

describe('isMcpHealExhaustedError', () => {
  it('detects rate limit and dead transport', () => {
    expect(isMcpHealExhaustedError("You've hit your limit · resets 1am")).toBe(true)
    expect(isMcpHealExhaustedError('ProcessTransport is not ready for writing')).toBe(true)
    expect(isMcpHealExhaustedError('Stream closed')).toBe(true)
  })
})
