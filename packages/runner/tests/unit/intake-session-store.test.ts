import { describe, it, expect, beforeEach } from 'vitest'
import {
  INTAKE_EVIDENCE_MAX_RESULT_CHARS,
  bindIntakeExecutor,
  buildIntakeMessages,
  deleteIntakeSession,
  getIntakeSession,
  hydrateIntakeSession,
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
