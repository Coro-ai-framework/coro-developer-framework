import { describe, expect, it } from 'vitest'
import { isStaleSessionResumeError } from '../src/session-errors'

const STALE_RESUME_MSG =
  'Claude Code returned an error result: API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)"},"request_id":"req_011CbSoJtBB8LnKSygdDYeGw"}'

describe('isStaleSessionResumeError', () => {
  it('matches Anthropic previous_message_id resume failures', () => {
    expect(isStaleSessionResumeError(new Error(STALE_RESUME_MSG))).toBe(true)
  })

  it('rejects unrelated 400 errors', () => {
    expect(
      isStaleSessionResumeError(
        new Error('Claude Code returned an error result: API Error: 400 {"message":"bad model"}'),
      ),
    ).toBe(false)
  })

  it('rejects unrelated infrastructure errors', () => {
    expect(isStaleSessionResumeError(new Error('connection reset'))).toBe(false)
  })
})
