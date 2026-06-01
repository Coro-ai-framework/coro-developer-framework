import { describe, it, expect } from 'vitest'
import { parseBrief, parseReviewersList } from '../../../dashboard/src/lib/intake-brief'

const KNOWN = ['workflows/job/workflow.md', 'workflows/job-fast/workflow.md']

describe('parseBrief', () => {
  it('extracts and validates a well-formed brief', () => {
    const message = `Here is your brief:
<brief>
{
  "repo": "org/my-service",
  "serviceName": "My Service",
  "description": "Add rate limiting to the users endpoint with clear acceptance criteria.",
  "reviewers": ["alice", "bob"],
  "workflowPath": "workflows/job/workflow.md",
  "interactive": true
}
</brief>`

    const brief = parseBrief(message, KNOWN)
    expect(brief).toEqual({
      repo: 'org/my-service',
      serviceName: 'My Service',
      description: 'Add rate limiting to the users endpoint with clear acceptance criteria.',
      reviewers: 'alice, bob',
      workflowPath: 'workflows/job/workflow.md',
      interactive: true,
    })
  })

  it('returns null when workflow path is unknown', () => {
    const message = `<brief>{"repo":"org/x","description":"A long enough description here.","workflowPath":"workflows/unknown/workflow.md"}</brief>`
    expect(parseBrief(message, KNOWN)).toBeNull()
  })

  it('returns null when description is too short', () => {
    const message = `<brief>{"repo":"org/x","description":"short","workflowPath":"workflows/job/workflow.md"}</brief>`
    expect(parseBrief(message, KNOWN)).toBeNull()
  })

  it('returns null when no brief tag is present', () => {
    expect(parseBrief('Just chatting', KNOWN)).toBeNull()
  })

  it('defaults interactive to true when omitted', () => {
    const message = `<brief>{"repo":"org/x","description":"A long enough description here for the planner.","workflowPath":"workflows/job/workflow.md"}</brief>`
    expect(parseBrief(message, KNOWN)?.interactive).toBe(true)
  })
})

describe('parseReviewersList', () => {
  it('splits comma-separated names and trims whitespace', () => {
    expect(parseReviewersList('alice, bob')).toEqual(['alice', 'bob'])
    expect(parseReviewersList('alice,')).toEqual(['alice'])
    expect(parseReviewersList('')).toEqual([])
  })
})
