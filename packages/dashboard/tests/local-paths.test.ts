import { describe, expect, it } from 'vitest'
import { splitLocalPaths } from '../src/lib/local-paths'

const paths = (text: string) => splitLocalPaths(text).flatMap(segment => (segment.path ? [segment.path] : []))

describe('splitLocalPaths', () => {
  it('finds scratch and home paths, in prose or backticks, without trailing punctuation', () => {
    expect(paths('Cloned into `/var/folders/zq/T/coro-plan-abc/repos/org-svc@main`.'))
      .toEqual(['/var/folders/zq/T/coro-plan-abc/repos/org-svc@main'])
    expect(paths('See /Users/me/src/app/main.go:42 and ~/notes/plan.md.')).toEqual(['/Users/me/src/app/main.go', '~/notes/plan.md'])
    expect(paths('Windows: C:\\Users\\me\\repo')).toEqual(['C:\\Users\\me\\repo'])
  })

  it('leaves URLs, API routes and bare roots as text', () => {
    expect(paths('https://example.com/home/docs and file:///Users/me/x')).toEqual([])
    expect(paths('POST /jobs/:id/open or /api/users, and /Users alone')).toEqual([])
  })

  it('keeps the text around a path intact', () => {
    const text = 'Wrote (/tmp/coro-plan-1/notes.md) for you'
    expect(splitLocalPaths(text).map(segment => segment.text).join('')).toBe(text)
  })
})
