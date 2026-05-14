// Phase 8.1 — schema lock for the cloud `jobs` table.
//
// Drizzle exposes column metadata on the table object. We assert the
// `conversation_history` column exists so a later refactor can't silently
// drop the field that round-trips stateless-executor history through the
// cloud control plane.

import { describe, it, expect } from 'vitest'
import { jobs } from '../../src/cloud/db/schema'

describe('cloud jobs schema (Phase 8.1)', () => {
  it('declares conversation_history alongside session_id', () => {
    // Drizzle column objects expose the SQL column name.
    expect(jobs.sessionId.name).toBe('session_id')
    expect(jobs.conversationHistory.name).toBe('conversation_history')
  })

  it('conversation_history is nullable JSON', () => {
    // `notNull` defaults to false on jsonb without `.notNull()` — the
    // column has to be optional so Anthropic-backed jobs (which omit
    // history and resume by sessionId) write null.
    expect(jobs.conversationHistory.notNull).toBe(false)
    expect(jobs.conversationHistory.dataType).toBe('json')
  })
})
