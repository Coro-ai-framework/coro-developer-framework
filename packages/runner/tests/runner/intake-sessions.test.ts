import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import pino from 'pino'
import { createRunnerServer } from '../../src/runner/server'
import { SqliteStateBackend } from '../../src/state/sqlite-backend'
import {
  getIntakeSession,
  peekIntakeSession,
  recordIntakeTurn,
  resetIntakeSessionsForTests,
} from '../../src/intake/session-store'
import { resolveIntelligenceRoot } from '../integration/repo-root'

const silentLogger = pino({ level: 'silent' })
const usage = { inputTokens: 10, outputTokens: 4 }

describe('intake session HTTP', () => {
  let tmpDir: string
  let backend: SqliteStateBackend
  const closeFns: Array<() => Promise<void>> = []

  beforeEach(async () => {
    resetIntakeSessionsForTests()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-intake-http-'))
    backend = new SqliteStateBackend(
      path.join(tmpDir, 'state.db'),
      resolveIntelligenceRoot(),
      { warn: () => {}, debug: () => {} },
    )
    await backend.initialize()
  })

  afterEach(async () => {
    for (const close of closeFns.splice(0)) await close()
    backend.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    resetIntakeSessionsForTests()
  })

  async function start() {
    const server = createRunnerServer({
      port: 0,
      dispatcher: {} as never,
      stateBackend: backend,
      logger: silentLogger,
      mode: 'local',
    })
    if (!server.listening) {
      await new Promise<void>(resolve => server.once('listening', () => resolve()))
    }
    const port = (server.address() as AddressInfo).port
    closeFns.push(() => new Promise<void>(resolve => server.close(() => resolve())))
    return `http://127.0.0.1:${port}`
  }

  it('skips inserting an empty snapshot', async () => {
    const base = await start()
    const res = await fetch(`${base}/intake/sessions/empty-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [], title: 'Draft' }),
    })
    expect(res.ok).toBe(true)
    expect(await res.json()).toEqual({ persisted: false, session: null })
    const list = await fetch(`${base}/intake/sessions?limit=5&offset=0`).then(r => r.json())
    expect(list.total).toBe(0)
  })

  it('puts, lists, loads, and rehydrates the in-memory session', async () => {
    const base = await start()
    const id = 'inv-http-1'
    recordIntakeTurn(id, {
      user: 'Add rate limiting',
      assistant: 'I will look at the repo.',
      evidence: [{ name: 'scm_read_file', args: 'path', result: 'ok' }],
      usage,
    })

    const put = await fetch(`${base}/intake/sessions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ kind: 'message', id: '1', role: 'user', text: 'Add rate limiting' }],
        title: 'Add rate limiting',
        readiness: { state: 'investigating', openQuestions: [], note: '' },
        modelChoice: { provider: 'anthropic', model: 'claude' },
        turnCount: 1,
        tokens: 14,
        contextUsed: 14,
      }),
    })
    const putBody = await put.json() as { persisted: boolean; session: { turns: unknown[] } }
    expect(putBody.persisted).toBe(true)
    expect(putBody.session.turns).toHaveLength(1)

    resetIntakeSessionsForTests()
    expect(peekIntakeSession(id)).toBeUndefined()

    const loaded = await fetch(`${base}/intake/sessions/${id}`).then(r => r.json()) as {
      items: unknown[]
      turns: Array<{ user: string }>
    }
    expect(loaded.turns[0]?.user).toBe('Add rate limiting')
    expect(loaded.items).toHaveLength(1)
    expect(getIntakeSession(id).turns[0]?.user).toBe('Add rate limiting')

    const list = await fetch(`${base}/intake/sessions?limit=5&offset=0`).then(r => r.json())
    expect(list.total).toBe(1)
    expect(list.sessions[0]?.title).toBe('Add rate limiting')
    expect(list.sessions[0]?.items).toBeUndefined()
  })

  it('deletes both the map and the row', async () => {
    const base = await start()
    const id = 'inv-del'
    await fetch(`${base}/intake/sessions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ kind: 'message', id: '1', role: 'user', text: 'hello' }],
        title: 'hello',
      }),
    })
    const del = await fetch(`${base}/intake/sessions/${id}`, { method: 'DELETE' })
    expect(await del.json()).toMatchObject({ deleted: true })
    expect(await fetch(`${base}/intake/sessions/${id}`).then(r => r.status)).toBe(404)
    expect(peekIntakeSession(id)).toBeUndefined()
  })
})
