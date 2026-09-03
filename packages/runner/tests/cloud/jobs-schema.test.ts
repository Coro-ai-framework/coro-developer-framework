// Phase 8.1 — schema lock for the cloud `jobs` table.
//
// Drizzle exposes column metadata on the table object. We assert the
// `conversation_history` column exists so a later refactor can't silently
// drop the field that round-trips stateless-executor history through the
// cloud control plane.

import { describe, it, expect } from 'vitest'
import { jobs, investigations } from '../../src/cloud/db/schema'

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

describe('cloud investigations schema', () => {
  it('stores the investigation JSON blob team-scoped with an updated_at index column', () => {
    expect(investigations.id.name).toBe('id')
    expect(investigations.teamId.name).toBe('team_id')
    expect(investigations.data.name).toBe('data')
    expect(investigations.status.name).toBe('status')
    expect(investigations.updatedAt.name).toBe('updated_at')
    expect(investigations.data.dataType).toBe('json')
  })
})
