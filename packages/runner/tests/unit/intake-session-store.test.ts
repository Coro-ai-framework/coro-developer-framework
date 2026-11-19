import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  INTAKE_EVIDENCE_MAX_RESULT_CHARS,
  INTAKE_SESSION_TTL_MS,
  bindIntakeExecutor,
  ensureIntakeWorkRoot,
  intakeScratchRoot,
  pruneLegacyIntakeWorkRoots,
  buildIntakeMessages,
  deleteIntakeSession,
  getIntakeSession,
  hydrateIntakeSession,
  isIntakeSessionDiscarded,
  peekIntakeSession,
  persistIntakeExecutorSession,
  recordIntakeTurn,
  reconcileIntakeSession,
  renderIntakeEvidence,
  resetIntakeSessionsForTests,
  seedIntakeSession,
} from '../../src/intake/session-store'

const usage = { inputTokens: 10, outputTokens: 4 }

beforeEach(() => {
  resetIntakeSessionsForTests()
})

describe('buildIntakeMessages', () => {
  it('alternates user/assistant and ends with the pending message', () => {
    recordIntakeTurn('s', { user: 'first', assistant: 'reply one', evidence: [], usage })
    recordIntakeTurn('s', { user: 'second', assistant: 'reply two', evidence: [], usage })

    expect(buildIntakeMessages(getIntakeSession('s'), 'third')).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply one' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply two' },
      { role: 'user', content: 'third' },
    ])
  })

  it('attaches tool evidence to the assistant turn that produced it', () => {
    recordIntakeTurn('s', {
      user: 'what is in api.ts?',
      assistant: 'It sets the limit.',
      evidence: [
        renderIntakeEvidence({
          name: 'scm_read_file',
          input: { repo: 'org/x', path: 'src/api.ts' },
          output: 'export const rateLimit = 100',
        }),
      ],
      usage,
    })

    const [, assistant] = buildIntakeMessages(getIntakeSession('s'), 'next')
    expect(assistant!.content).toContain('It sets the limit.')
    expect(assistant!.content).toContain('scm_read_file({"repo":"org/x","path":"src/api.ts"})')
    expect(assistant!.content).toContain('export const rateLimit = 100')
  })

  it('records a failed call as evidence so the model does not retry it blindly', () => {
    const evidence = renderIntakeEvidence({
      name: 'scm_search_code',
      input: { repo: 'org/x', query: 'rateLimit' },
      output: null,
      error: 'Tool timed out after 15000ms',
    })
    expect(evidence).toMatchObject({ failed: true, result: 'failed: Tool timed out after 15000ms' })
  })
})

describe('renderIntakeEvidence', () => {
  it('clamps an oversized result at record time', () => {
    const evidence = renderIntakeEvidence({
      name: 'scm_read_file',
      input: { path: 'big.ts' },
      output: 'x'.repeat(INTAKE_EVIDENCE_MAX_RESULT_CHARS * 2),
    })
    expect(evidence.result.length).toBeLessThan(INTAKE_EVIDENCE_MAX_RESULT_CHARS + 40)
    expect(evidence.result).toContain('[truncated]')
  })
})

describe('seedIntakeSession', () => {
  it('rebuilds turns from a client transcript', () => {
    const session = seedIntakeSession('s', [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
    ])
    expect(session.turns).toEqual([
      { user: 'one', assistant: 'two', evidence: [] },
      { user: 'three', assistant: 'four', evidence: [] },
    ])
  })

  it('records a trailing user message that never got a reply', () => {
    const session = seedIntakeSession('s', [
      { role: 'user', content: 'look at auth' },
    ])
    expect(session.turns).toEqual([
      { user: 'look at auth', assistant: '(no reply recorded)', evidence: [] },
    ])
  })
})

describe('reconcileIntakeSession', () => {
  it('appends turns the client has that the server never recorded', () => {
    recordIntakeTurn('s', { user: 'first', assistant: 'reply one', evidence: [], usage })
    persistIntakeExecutorSession('s', { sessionId: 'claude-1' })

    const session = reconcileIntakeSession('s', [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply one' },
      { role: 'user', content: 'look at auth' },
    ])

    expect(session.turns).toHaveLength(2)
    expect(session.turns[1]).toEqual({
      user: 'look at auth',
      assistant: '(no reply recorded)',
      evidence: [],
    })
    expect(session.executorSession).toBeUndefined()
  })
})

describe('bindIntakeExecutor', () => {
  it('drops resume state when the provider changes', () => {
    persistIntakeExecutorSession('s', { sessionId: 'claude-1' })
    bindIntakeExecutor('s', 'anthropic')
    expect(getIntakeSession('s').executorSession).toEqual({ sessionId: 'claude-1' })
    bindIntakeExecutor('s', 'openai')
    expect(getIntakeSession('s').executorSession).toBeUndefined()
    expect(getIntakeSession('s').executorId).toBe('openai')
  })
})

describe('deleteIntakeSession', () => {
  it('drops the conversation so a new one starts empty', () => {
    recordIntakeTurn('s', { user: 'hello', assistant: 'hi', evidence: [], usage })
    expect(deleteIntakeSession('s')).toBe(true)
    expect(getIntakeSession('s').turns).toEqual([])
  })

  it('tombstones the id so an in-flight turn cannot resurrect the row', () => {
    recordIntakeTurn('s', { user: 'hello', assistant: 'hi', evidence: [], usage })
    expect(isIntakeSessionDiscarded('s')).toBe(false)
    deleteIntakeSession('s')
    expect(isIntakeSessionDiscarded('s')).toBe(true)
    // The abandoned turn lands after the delete and recreates the cache entry.
    recordIntakeTurn('s', { user: 'hello', assistant: 'late reply', evidence: [], usage })
    expect(peekIntakeSession('s')?.turns).toHaveLength(1)
    expect(isIntakeSessionDiscarded('s')).toBe(true)
  })

  it('does not tombstone conversations that were never deleted', () => {
    recordIntakeTurn('other', { user: 'hello', assistant: 'hi', evidence: [], usage })
    deleteIntakeSession('s')
    expect(isIntakeSessionDiscarded('other')).toBe(false)
  })
})

describe('recordIntakeTurn', () => {
  it('bills extra tokens without growing the context window', () => {
    const session = recordIntakeTurn('s', {
      user: 'q',
      assistant: 'a',
      evidence: [],
      usage,
      extraBilledTokens: 7,
    })
    expect(session.tokens).toBe(21)
    expect(session.contextTokens).toBe(14)
  })

  it('takes the executor-measured context over anything summed from usage', () => {
    const session = recordIntakeTurn('s', {
      user: 'q',
      assistant: 'a',
      evidence: [],
      usage: { inputTokens: 30, outputTokens: 900, cacheReadInputTokens: 120_000, cacheCreationInputTokens: 5_000 },
      contextTokens: 46_000,
    })
    expect(session.contextTokens).toBe(46_000)
  })

  it('counts cached prompt tokens when the executor does not measure context', () => {
    const session = recordIntakeTurn('s', {
      user: 'q',
      assistant: 'a',
      evidence: [],
      usage: { inputTokens: 30, outputTokens: 900, cacheReadInputTokens: 40_000, cacheCreationInputTokens: 2_000 },
    })
    expect(session.contextTokens).toBe(42_930)
  })
})

describe('hydrateIntakeSession', () => {
  it('restores turns into the hot cache without creating a duplicate empty session first', () => {
    expect(peekIntakeSession('restored')).toBeUndefined()
    hydrateIntakeSession({
      id: 'restored',
      turns: [{ user: 'hello', assistant: 'hi', evidence: [] }],
      tokens: 20,
      contextTokens: 12,
      executorId: 'anthropic',
    })
    const session = peekIntakeSession('restored')
    expect(session?.turns).toEqual([{ user: 'hello', assistant: 'hi', evidence: [] }])
    expect(session?.tokens).toBe(20)
    expect(session?.executorId).toBe('anthropic')
  })
})

describe('scratch directory', () => {
  let home: string
  let savedHome: string | undefined

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-scratch-home-'))
    savedHome = process.env['HOME']
    process.env['HOME'] = home
  })

  afterEach(() => {
    vi.useRealTimers()
    resetIntakeSessionsForTests()
    if (savedHome !== undefined) process.env['HOME'] = savedHome
    fs.rmSync(home, { recursive: true, force: true })
  })

  function evictIdleSessions(): void {
    vi.useFakeTimers({ now: Date.now() + INTAKE_SESSION_TTL_MS + 1 })
  }

  it('outlives cache eviction, so the next turn finds its earlier files', () => {
    const root = ensureIntakeWorkRoot('conv-1')
    fs.writeFileSync(path.join(root, 'probe.sh'), 'echo ok')

    evictIdleSessions()
    expect(peekIntakeSession('conv-1')).toBeUndefined()

    expect(ensureIntakeWorkRoot('conv-1')).toBe(root)
    expect(fs.readFileSync(path.join(root, 'probe.sh'), 'utf8')).toBe('echo ok')
    expect(root.startsWith(path.join(home, '.coro', 'plan') + path.sep)).toBe(true)
  })

  it('keeps an id that is not a plain token inside the scratch root', () => {
    const root = ensureIntakeWorkRoot('../../escape')
    expect(path.dirname(root)).toBe(intakeScratchRoot())
  })

  it('is removed with the conversation, even after the cache dropped it', () => {
    const root = ensureIntakeWorkRoot('conv-2')
    evictIdleSessions()
    deleteIntakeSession('conv-2')
    expect(fs.existsSync(root)).toBe(false)
  })
})

describe('pruneLegacyIntakeWorkRoots', () => {
  it('removes only legacy temp directories untouched for longer than the grace period', async () => {
    const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-plan-prune-stale-'))
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'coro-plan-prune-fresh-'))
    const longAgo = new Date('2001-01-01T00:00:00Z')
    fs.utimesSync(stale, longAgo, longAgo)
    try {
      // A cut-off in 2002 so no real legacy directory on this machine qualifies.
      const now = Date.now()
      await pruneLegacyIntakeWorkRoots(now - Date.parse('2002-01-01T00:00:00Z'), now)
      expect(fs.existsSync(stale)).toBe(false)
      expect(fs.existsSync(fresh)).toBe(true)
    } finally {
      fs.rmSync(stale, { recursive: true, force: true })
      fs.rmSync(fresh, { recursive: true, force: true })
    }
  })
})
