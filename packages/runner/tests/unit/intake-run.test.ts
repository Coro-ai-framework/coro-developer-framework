import { describe, it, expect } from 'vitest'
import { parseRun, parseReviewersList } from '../../../dashboard/src/lib/intake-run'

const KNOWN = ['workflows/job/workflow.md', 'workflows/job-fast/workflow.md']

describe('parseRun', () => {
  it('extracts and validates a well-formed run', () => {
    const message = `Here is the run:
<run>
{
  "repo": "org/my-service",
  "serviceName": "My Service",
  "description": "Add rate limiting to the users endpoint with clear acceptance criteria.",
  "reviewers": ["alice", "bob"],
  "workflowPath": "workflows/job/workflow.md",
  "interactive": true
}
</run>`

    const run = parseRun(message, KNOWN)
    expect(run).toEqual({
      repo: 'org/my-service',
      serviceName: 'My Service',
      description: 'Add rate limiting to the users endpoint with clear acceptance criteria.',
      reviewers: 'alice, bob',
      workflowPath: 'workflows/job/workflow.md',
      interactive: true,
    })
  })

  it('returns null when workflow path is unknown', () => {
    const message = `<run>{"repo":"org/x","description":"A long enough description here.","workflowPath":"workflows/unknown/workflow.md"}</run>`
    expect(parseRun(message, KNOWN)).toBeNull()
  })

  it('returns null when description is too short', () => {
    const message = `<run>{"repo":"org/x","description":"short","workflowPath":"workflows/job/workflow.md"}</run>`
    expect(parseRun(message, KNOWN)).toBeNull()
  })

  it('returns null when no run tag is present', () => {
    expect(parseRun('Just chatting', KNOWN)).toBeNull()
  })

  it('ignores a readiness block that carries no run', () => {
    const message = `Still digging.
<readiness>{"state":"investigating","openQuestions":["which repo?"],"note":"scoping"}</readiness>`
    expect(parseRun(message, KNOWN)).toBeNull()
  })

  it('defaults interactive to true when omitted', () => {
    const message = `<run>{"repo":"org/x","description":"A long enough description here for the planner.","workflowPath":"workflows/job/workflow.md"}</run>`
    expect(parseRun(message, KNOWN)?.interactive).toBe(true)
  })
})

describe('parseReviewersList', () => {
  it('splits comma-separated names and trims whitespace', () => {
    expect(parseReviewersList('alice, bob')).toEqual(['alice', 'bob'])
    expect(parseReviewersList('alice,')).toEqual(['alice'])
    expect(parseReviewersList('')).toEqual([])
  })
})
