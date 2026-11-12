import { describe, expect, it } from 'vitest'
import { composeAnswerMessage, parseReadiness, readinessQuestions } from '../src/lib/intake-readiness'
import { displayContent } from '../src/components/activity/message-block'

describe('parseReadiness', () => {
  it('reads state, open questions, and note', () => {
    const message = `Looked at the handler.
<readiness>
{"state":"investigating","openQuestions":["which repo?","what happens on timeout?"],"note":"scoping the change"}
</readiness>`
    expect(parseReadiness(message)).toMatchObject({
      state: 'investigating',
      openQuestions: ['which repo?', 'what happens on timeout?'],
      questions: [
        { id: 'q0', header: 'Question 1', question: 'which repo?', options: [] },
        { id: 'q1', header: 'Question 2', question: 'what happens on timeout?', options: [] },
      ],
      note: 'scoping the change',
    })
  })

  it('reads structured questions with context and options', () => {
    const message = `<readiness>${JSON.stringify({
      state: 'investigating',
      openQuestions: [
        { question: '' },
        {
          header: 'Upgrade path',
          question: 'Should v2 accounts move to v3 on next login?',
          context: 'The migration flag in billing.ts is unused.',
          options: [
            { label: 'Forced', description: 'Every v2 account moves', recommended: true },
            'Optional',
            { description: 'no label' },
          ],
          multiSelect: true,
        },
      ],
      note: '',
    })}</readiness>`
    const readiness = parseReadiness(message)
    expect(readiness?.openQuestions).toEqual(['Should v2 accounts move to v3 on next login?'])
    expect(readiness?.questions).toEqual([
      {
        id: 'q0',
        header: 'Upgrade path',
        question: 'Should v2 accounts move to v3 on next login?',
        context: 'The migration flag in billing.ts is unused.',
        options: [
          { label: 'Forced', description: 'Every v2 account moves', recommended: true },
          { label: 'Optional', description: '', recommended: false },
        ],
        multiSelect: true,
      },
    ])
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

describe('readinessQuestions', () => {
  it('falls back to plain open questions on readiness saved without structure', () => {
    expect(
      readinessQuestions({ state: 'investigating', openQuestions: ['which repo?'], note: '' }),
    ).toMatchObject([{ id: 'q0', question: 'which repo?' }])
    expect(readinessQuestions(null)).toEqual([])
  })
})

describe('composeAnswerMessage', () => {
  const questions = [
    {
      id: 'q0',
      header: 'Upgrade',
      question: 'Force the upgrade?',
      context: '',
      options: [
        { label: 'Forced', description: '', recommended: true },
        { label: 'Optional', description: '', recommended: false },
      ],
      multiSelect: false,
    },
    { id: 'q1', header: 'Name', question: 'What should the flag be called?', context: '', options: [], multiSelect: false },
  ]

  it('quotes each question and marks unanswered ones as skipped', () => {
    const message = composeAnswerMessage(questions, { q0: { selected: [0], other: '' } }, 'also check staging')
    expect(message).toBe(
      'Answers to your open questions:\n\n'
        + '1. Force the upgrade?\n   → Forced\n\n'
        + '2. What should the flag be called?\n   → Skipped — use your judgement and say what you assumed.\n\n'
        + 'also check staging',
    )
  })

  it('combines picked options with a typed answer', () => {
    const message = composeAnswerMessage(
      questions,
      { q0: { selected: [1], other: 'only for EU' }, q1: { selected: [], other: 'v3_upgrade' } },
    )
    expect(message).toContain('→ Optional; only for EU')
    expect(message).toContain('→ v3_upgrade')
  })

  it('sends only the composer text when nothing was answered', () => {
    expect(composeAnswerMessage(questions, {}, '  dig into the cron  ')).toBe('dig into the cron')
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
