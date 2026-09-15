import { beforeEach, describe, expect, it } from 'vitest'
import type { Investigation, InvestigationPatch } from '@coro-ai/cloud-protocol'
import type { StateBackend } from '../../src/state/backend'
import { persistIntakeSnapshot, persistLiveIntakeSession } from '../../src/intake/persist'
import {
  deleteIntakeSession,
  recordIntakeTurn,
  resetIntakeSessionsForTests,
} from '../../src/intake/session-store'
import { mergeInvestigation } from '../../src/state/investigation'

const usage = { inputTokens: 10, outputTokens: 4 }

function backend(): StateBackend & { rows: Map<string, Investigation> } {
  const rows = new Map<string, Investigation>()
  const stub = {
    rows,
    async getInvestigation(id: string) {
      return rows.get(id) ?? null
    },
    async upsertInvestigation(patch: InvestigationPatch) {
      const merged = mergeInvestigation(rows.get(patch.id) ?? null, patch, new Date().toISOString())
      rows.set(patch.id, merged)
      return merged
    },
  }
  return stub as unknown as StateBackend & { rows: Map<string, Investigation> }
}

beforeEach(() => {
  resetIntakeSessionsForTests()
})

describe('persisting a discarded conversation', () => {
  it('refuses the runner’s own write, so a late turn cannot recreate the row', async () => {
    const state = backend()
    recordIntakeTurn('s', { user: 'hello', assistant: 'hi', evidence: [], usage })
    deleteIntakeSession('s')

    // The abandoned turn finishes here: it records into a fresh cache entry
    // and then asks for that entry to be persisted.
    recordIntakeTurn('s', { user: 'hello', assistant: 'late reply', evidence: [], usage })
    expect(await persistLiveIntakeSession(state, 's')).toBeNull()
    expect(state.rows.has('s')).toBe(false)
  })

  it('refuses a dashboard snapshot for the same id', async () => {
    const state = backend()
    deleteIntakeSession('s')
    const result = await persistIntakeSnapshot(state, 's', {
      items: [{ kind: 'message', role: 'user', text: 'hello' }],
      title: 'hello',
    })
    expect(result).toEqual({ persisted: false, session: null })
    expect(state.rows.has('s')).toBe(false)
  })

  it('still persists conversations that were never discarded', async () => {
    const state = backend()
    recordIntakeTurn('live', { user: 'hello', assistant: 'hi', evidence: [], usage })
    expect(await persistLiveIntakeSession(state, 'live')).not.toBeNull()
    expect(state.rows.get('live')?.turns).toHaveLength(1)
  })
})
