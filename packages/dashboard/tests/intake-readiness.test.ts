import { describe, expect, it } from 'vitest'
import { parseReadiness } from '../src/lib/intake-readiness'
import { displayContent } from '../src/components/activity/message-block'

describe('parseReadiness', () => {
  it('reads state, open questions, and note', () => {
    const message = `Looked at the handler.
<readiness>
{"state":"investigating","openQuestions":["which repo?","what happens on timeout?"],"note":"scoping the change"}
</readiness>`
    expect(parseReadiness(message)).toEqual({
      state: 'investigating',
      openQuestions: ['which repo?', 'what happens on timeout?'],
      note: 'scoping the change',
    })
  })

  it('accepts a ready state with nothing open', () => {
    const message = `<readiness>{"state":"ready","openQuestions":[],"note":"clear"}</readiness>`
    expect(parseReadiness(message)?.state).toBe('ready')
  })

  it('downgrades a ready claim that still lists open questions', () => {
    const message = `<readiness>{"state":"ready","openQuestions":["which service owns this?"]}</readiness>`
    expect(parseReadiness(message)).toMatchObject({
      state: 'investigating',
      openQuestions: ['which service owns this?'],
    })
  })

  it('carries the no-run-needed conclusion', () => {
    const message = `<readiness>{"state":"no-run-needed","openQuestions":[],"note":"already handled upstream"}</readiness>`
    expect(parseReadiness(message)).toMatchObject({ state: 'no-run-needed' })
  })

  it('returns null for a missing, malformed, or unknown-state block', () => {
    expect(parseReadiness('no block here')).toBeNull()
    expect(parseReadiness('<readiness>not json</readiness>')).toBeNull()
    expect(parseReadiness('<readiness>{"state":"vibes"}</readiness>')).toBeNull()
  })
})

describe('displayContent', () => {
  it('hides run, readiness, and findings payloads from the assistant bubble', () => {
    const message = `Here is what I found.
<findings>
## Decode path
Stateless.
</findings>
<run>{"repo":"org/x"}</run>
<readiness>{"state":"ready","openQuestions":[]}</readiness>`
    expect(displayContent('assistant', message)).toBe('Here is what I found.')
  })

  it('substitutes a pointer to the card when the turn is only a run', () => {
    const displayed = displayContent('assistant', '<run>{"repo":"org/x"}</run>')
    expect(displayed).toContain('below')
  })

  it('renders nothing for a findings-only or readiness-only turn', () => {
    expect(displayContent('assistant', '<readiness>{"state":"ready"}</readiness>')).toBe('')
    expect(
      displayContent(
        'assistant',
        '<findings>\n## Decode path\nStateless.\n</findings>\n<readiness>{"state":"ready"}</readiness>',
      ),
    ).toBe('')
  })

  it('hides a payload block that is still streaming in', () => {
    expect(displayContent('assistant', 'Checking the repo.\n<readiness>\n{"state":"inv')).toBe(
      'Checking the repo.',
    )
    expect(displayContent('assistant', 'Checking the repo.\n<readi')).toBe('Checking the repo.')
    expect(displayContent('assistant', 'Checking the repo.\n<findi')).toBe('Checking the repo.')
  })

  it('leaves user messages untouched', () => {
    expect(displayContent('user', 'compare <run> and <readiness>')).toBe('compare <run> and <readiness>')
  })
})
