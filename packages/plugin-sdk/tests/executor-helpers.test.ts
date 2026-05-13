// Lock-down tests for the executor helpers. These mirror the runner's
// PreToolUse enforcement (`packages/runner/src/jobs/runner.ts →
// buildPhaseHooks`) — drift here is a security regression.

import { describe, expect, it } from 'vitest'
import * as path from 'node:path'

import {
  accumulateNormalizedUsage,
  emptyNormalizedUsage,
  enforceAllowedTools,
  enforceWriteGuard,
  formatToolCallLogLine,
  isDoneEvent,
  isPathInside,
  isUsageEvent,
  mergeConversationHistory,
} from '../src/executor-helpers'
import type { ConversationMessage, PhaseExecutorEvent } from '../src/types'

// ── enforceAllowedTools ─────────────────────────────────────────────────────

describe('enforceAllowedTools', () => {
  it('allows when whitelist is null', () => {
    expect(enforceAllowedTools('Bash', null)).toEqual({ allow: true })
  })

  it('allows when whitelist is empty (treated as no whitelist)', () => {
    expect(enforceAllowedTools('Bash', [])).toEqual({ allow: true })
  })

  it('allows tool present in whitelist', () => {
    expect(enforceAllowedTools('Read', ['Read', 'Glob'])).toEqual({ allow: true })
  })

  it('denies tool absent from whitelist with stable reason phrasing', () => {
    const result = enforceAllowedTools('Bash', ['Read', 'Glob'], { phase: 'planning' })
    expect(result.allow).toBe(false)
    expect(result.reason).toContain('Blocked Bash')
    expect(result.reason).toContain('phase planning')
    expect(result.reason).toContain('Read, Glob')
  })

  it('falls back to generic phase label when ctx omitted', () => {
    const result = enforceAllowedTools('Bash', ['Read'])
    expect(result.reason).toContain('this phase')
  })
})

// ── isPathInside ────────────────────────────────────────────────────────────

describe('isPathInside', () => {
  const root = '/tmp/work'

  it('matches the root itself', () => {
    expect(isPathInside('/tmp/work', root)).toBe(true)
  })

  it('matches nested children', () => {
    expect(isPathInside('/tmp/work/sub/file.ts', root)).toBe(true)
  })

  it('rejects siblings', () => {
    expect(isPathInside('/tmp/other/file.ts', root)).toBe(false)
  })

  it('rejects path-traversal escapes after resolution', () => {
    const escaped = path.resolve('/tmp/work', '../etc/passwd')
    expect(isPathInside(escaped, root)).toBe(false)
  })
})

// ── enforceWriteGuard ───────────────────────────────────────────────────────

describe('enforceWriteGuard', () => {
  const cwd = '/tmp/job/working'
  const writeRoots = ['/tmp/job/working', '/tmp/intel/memory']

  it('allows non-write tools regardless of inputs', () => {
    expect(
      enforceWriteGuard({
        toolName: 'Read',
        toolInput: { file_path: '/etc/passwd' },
        cwd,
        writeRoots,
      }),
    ).toEqual({ allow: true })
  })

  it('allows Write inside the working dir', () => {
    expect(
      enforceWriteGuard({
        toolName: 'Write',
        toolInput: { file_path: 'src/foo.ts' },
        cwd,
        writeRoots,
      }),
    ).toEqual({ allow: true })
  })

  it('allows Edit inside an alternate write root (memory/)', () => {
    expect(
      enforceWriteGuard({
        toolName: 'Edit',
        toolInput: { file_path: '/tmp/intel/memory/notes.md' },
        cwd,
        writeRoots,
      }),
    ).toEqual({ allow: true })
  })

  it('denies Write outside all write roots', () => {
    const result = enforceWriteGuard({
      toolName: 'Write',
      toolInput: { file_path: '/etc/passwd' },
      cwd,
      writeRoots,
    })
    expect(result.allow).toBe(false)
    expect(result.reason).toContain('Blocked Write')
    expect(result.reason).toContain('/etc/passwd')
    expect(result.reason).toContain('propose_change')
  })

  it('denies Write attempting `..` traversal', () => {
    const result = enforceWriteGuard({
      toolName: 'Write',
      toolInput: { file_path: '../../etc/passwd' },
      cwd,
      writeRoots,
    })
    expect(result.allow).toBe(false)
  })

  it('honours custom path keys', () => {
    const result = enforceWriteGuard({
      toolName: 'Write',
      toolInput: { target: '/tmp/job/working/x.ts' },
      cwd,
      writeRoots,
      pathInputKeys: ['target'],
    })
    expect(result.allow).toBe(true)
  })

  it('honours custom write tool names', () => {
    const result = enforceWriteGuard({
      toolName: 'patch_file',
      toolInput: { file_path: '/etc/passwd' },
      cwd,
      writeRoots,
      writeToolNames: ['patch_file'],
    })
    expect(result.allow).toBe(false)
  })

  it('allows when path key absent (defers to tool schema)', () => {
    const result = enforceWriteGuard({
      toolName: 'Write',
      toolInput: { content: 'x' },
      cwd,
      writeRoots,
    })
    expect(result.allow).toBe(true)
  })

  it('denies all writes when writeRoots is empty', () => {
    const result = enforceWriteGuard({
      toolName: 'Write',
      toolInput: { file_path: '/tmp/job/working/x.ts' },
      cwd,
      writeRoots: [],
    })
    expect(result.allow).toBe(false)
    expect(result.reason).toContain('no write roots configured')
  })
})

// ── accumulateNormalizedUsage / emptyNormalizedUsage ────────────────────────

describe('accumulateNormalizedUsage', () => {
  it('starts at zero from emptyNormalizedUsage', () => {
    expect(emptyNormalizedUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    })
  })

  it('sums all token fields', () => {
    const result = accumulateNormalizedUsage(
      {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 40,
      },
      {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
      },
    )
    expect(result).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheReadInputTokens: 33,
      cacheCreationInputTokens: 44,
    })
  })

  it('omits totalCostUsd when neither side reports it', () => {
    const result = accumulateNormalizedUsage(emptyNormalizedUsage(), emptyNormalizedUsage())
    expect(result.totalCostUsd).toBeUndefined()
  })

  it('preserves cost when only acc reports it (next undefined ≠ zero)', () => {
    const result = accumulateNormalizedUsage(
      { ...emptyNormalizedUsage(), totalCostUsd: 0.5 },
      emptyNormalizedUsage(),
    )
    expect(result.totalCostUsd).toBe(0.5)
  })

  it('sums totalCostUsd when both report it', () => {
    const result = accumulateNormalizedUsage(
      { ...emptyNormalizedUsage(), totalCostUsd: 0.25 },
      { ...emptyNormalizedUsage(), totalCostUsd: 0.75 },
    )
    expect(result.totalCostUsd).toBeCloseTo(1.0)
  })
})

// ── mergeConversationHistory ────────────────────────────────────────────────

describe('mergeConversationHistory', () => {
  const a: ConversationMessage = { role: 'user', content: 'hi' }
  const b: ConversationMessage = { role: 'assistant', content: 'hello' }
  const c: ConversationMessage = { role: 'user', content: 'thanks' }

  it('returns next when prev is undefined', () => {
    expect(mergeConversationHistory(undefined, [a])).toEqual([a])
  })

  it('returns next when prev is empty', () => {
    expect(mergeConversationHistory([], [a])).toEqual([a])
  })

  it('returns prev when next is empty', () => {
    expect(mergeConversationHistory([a, b], [])).toEqual([a, b])
  })

  it('appends next after prev preserving order', () => {
    expect(mergeConversationHistory([a, b], [c])).toEqual([a, b, c])
  })
})

// ── formatToolCallLogLine ───────────────────────────────────────────────────

describe('formatToolCallLogLine', () => {
  it('renders simple input as JSON', () => {
    const line = formatToolCallLogLine({
      toolName: 'Read',
      input: { file_path: '/x' },
    })
    expect(line).toBe('tool=Read input={"file_path":"/x"}')
  })

  it('redacts default sensitive keys (case-insensitive, substring)', () => {
    const line = formatToolCallLogLine({
      toolName: 'Bash',
      input: { ApiKey: 'sk-1', AUTHORIZATION: 'bearer x', cmd: 'ls' },
    })
    expect(line).toContain('"ApiKey":"[REDACTED]"')
    expect(line).toContain('"AUTHORIZATION":"[REDACTED]"')
    expect(line).toContain('"cmd":"ls"')
  })

  it('redacts nested keys recursively', () => {
    const line = formatToolCallLogLine({
      toolName: 'http',
      input: { headers: { Authorization: 'bearer x' } },
    })
    expect(line).toContain('"Authorization":"[REDACTED]"')
  })

  it('redacts inside arrays', () => {
    const line = formatToolCallLogLine({
      toolName: 'http',
      input: { items: [{ token: 't1' }, { token: 't2' }] },
    })
    expect(line).toContain('"token":"[REDACTED]"')
    expect(line).not.toContain('t1')
    expect(line).not.toContain('t2')
  })

  it('truncates oversized output with an ellipsis', () => {
    const big = { value: 'x'.repeat(2048) }
    const line = formatToolCallLogLine({ toolName: 'Bash', input: big, maxInputBytes: 64 })
    expect(line.length).toBeLessThanOrEqual('tool=Bash input='.length + 64)
    expect(line.endsWith('…')).toBe(true)
  })

  it('handles circular references without throwing', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const line = formatToolCallLogLine({ toolName: 'Bash', input: cyclic })
    expect(line).toContain('[circular]')
  })

  it('honours custom redaction fragments', () => {
    const line = formatToolCallLogLine({
      toolName: 'foo',
      input: { customSecretField: 'x', other: 'y' },
      redactedKeyFragments: ['customsecret'],
    })
    expect(line).toContain('[REDACTED]')
    expect(line).toContain('"other":"y"')
  })
})

// ── Event type guards ───────────────────────────────────────────────────────

describe('event type guards', () => {
  const usage: PhaseExecutorEvent = {
    type: 'usage',
    tokens: emptyNormalizedUsage(),
  }
  const done: PhaseExecutorEvent = {
    type: 'done',
    stopReason: 'end_turn',
    sessionState: {},
  }
  const text: PhaseExecutorEvent = { type: 'text', content: 'hi' }

  it('isUsageEvent narrows correctly', () => {
    expect(isUsageEvent(usage)).toBe(true)
    expect(isUsageEvent(done)).toBe(false)
    expect(isUsageEvent(text)).toBe(false)
  })

  it('isDoneEvent narrows correctly', () => {
    expect(isDoneEvent(done)).toBe(true)
    expect(isDoneEvent(usage)).toBe(false)
    expect(isDoneEvent(text)).toBe(false)
  })
})
