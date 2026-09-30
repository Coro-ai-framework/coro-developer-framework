import { describe, expect, it } from 'vitest'
import { nextStickState } from '../src/components/activity/use-stick-to-bottom'

describe('nextStickState', () => {
  it('stays pinned when content grows and the scroll position does not move up', () => {
    expect(nextStickState(400, 400, false)).toBeNull()
    expect(nextStickState(400, 520, false)).toBeNull()
  })

  it('unpins only when the user scrolls up, and re-pins at the bottom', () => {
    expect(nextStickState(520, 400, false)).toBe(false)
    expect(nextStickState(400, 520, true)).toBe(true)
  })

  it('ignores a couple of pixels of scroll noise', () => {
    expect(nextStickState(400, 398, false)).toBeNull()
  })
})
