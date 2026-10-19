import { describe, expect, it } from 'vitest'
import { enforceAllowedTools } from '@coro-ai/plugin-sdk'
import { withRunnerToolEquivalents } from '../../src/tools/native-tool-equivalents'

const codeReviewerTools = ['Read', 'Glob', 'Grep', 'Bash', 'mcp__coro__log']

describe('withRunnerToolEquivalents', () => {
  it('adds runner MCP equivalents for executors without native file tools', () => {
    const allowed = withRunnerToolEquivalents(codeReviewerTools, { supportsNativeFileTools: false })
    expect(allowed).toEqual([
      'Read', 'Glob', 'Grep', 'Bash', 'mcp__coro__log',
      'mcp__coro__file_read', 'mcp__coro__file_glob', 'mcp__coro__file_grep', 'mcp__coro__shell',
    ])
    for (const name of ['mcp__coro__file_read', 'mcp__coro__file_glob', 'mcp__coro__file_grep', 'mcp__coro__shell']) {
      expect(enforceAllowedTools(name, allowed).allow).toBe(true)
    }
    expect(enforceAllowedTools('mcp__coro__file_write', allowed).allow).toBe(false)
  })

  it('leaves the list unchanged for executors with native file and web tools', () => {
    expect(withRunnerToolEquivalents(
      [...codeReviewerTools, 'WebFetch'],
      { supportsNativeFileTools: true, supportsNativeWebTools: true },
    )).toEqual([...codeReviewerTools, 'WebFetch'])
  })

  it('maps WebFetch only when the executor lacks native web tools', () => {
    expect(withRunnerToolEquivalents(['WebFetch'], { supportsNativeFileTools: true }))
      .toEqual(['WebFetch', 'mcp__coro__web_fetch'])
  })

  it('does not duplicate equivalents that are already listed', () => {
    expect(withRunnerToolEquivalents(['Read', 'mcp__coro__file_read'], { supportsNativeFileTools: false }))
      .toEqual(['Read', 'mcp__coro__file_read'])
  })
})
