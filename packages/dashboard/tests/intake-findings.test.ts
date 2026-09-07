import { describe, expect, it } from 'vitest'
import { findingsTitle, looksLikeFindingsReport, parseFindings, currentFindingsMarkdown } from '../src/lib/intake-findings'
import type { ActivityItem } from '../src/components/activity/types'

describe('parseFindings', () => {
  it('extracts the markdown body', () => {
    const message = `A sentence first.
<findings>
## Decode path
The handler is stateless.
</findings>
<readiness>{"state":"ready","openQuestions":[]}</readiness>`
    expect(parseFindings(message)).toBe('## Decode path\nThe handler is stateless.')
  })

  it('returns null for a missing or empty block', () => {
    expect(parseFindings('no block here')).toBeNull()
    expect(parseFindings('<findings>\n\n</findings>')).toBeNull()
  })
})

describe('findingsTitle', () => {
  it('uses the first heading', () => {
    expect(findingsTitle('## Decode path\n\nThe handler is stateless.')).toBe('Decode path')
  })

  it('falls back to the first line', () => {
    expect(findingsTitle('- The handler is stateless\n- Tool results are dropped')).toBe(
      'The handler is stateless',
    )
  })
})

describe('looksLikeFindingsReport', () => {
  it('rejects narrating sentences', () => {
    expect(
      looksLikeFindingsReport('Let me look at the route registration and the httpserver decode path.'),
    ).toBe(false)
  })

  it('accepts a headed write-up', () => {
    expect(
      looksLikeFindingsReport(`## What this change actually is

The HTTP server decodes the body in \`Server.go\` before the route runs.

### Files
- \`internal/http/Server.go\``),
    ).toBe(true)
  })
})

describe('currentFindingsMarkdown', () => {
  function findingsCard(markdown: string, state: 'current' | 'superseded', id: string): ActivityItem {
    return { kind: 'card', id, card: { type: 'findings', data: { markdown, state } } }
  }

  it('returns the last current findings card', () => {
    expect(currentFindingsMarkdown([
      findingsCard('## Old', 'superseded', 'c1'),
      findingsCard('## Current', 'current', 'c2'),
    ])).toBe('## Current')
  })

  it('ignores superseded cards and blank markdown', () => {
    expect(currentFindingsMarkdown([
      findingsCard('## Old', 'superseded', 'c1'),
      findingsCard('   ', 'current', 'c2'),
    ])).toBeNull()
  })

  it('returns null when there is no findings card', () => {
    expect(currentFindingsMarkdown([
      { kind: 'message', id: 'm1', role: 'user', text: 'hello' },
    ])).toBeNull()
  })
})
