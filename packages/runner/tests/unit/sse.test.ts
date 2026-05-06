import { describe, expect, it } from 'vitest'
import { formatSseFrame } from '../../src/runner/sse'

describe('formatSseFrame', () => {
  it('prefixes every line of multiline data with data:', () => {
    expect(formatSseFrame('first line\nsecond line\n\nfinal line')).toBe(
      'data: first line\n' +
      'data: second line\n' +
      'data: \n' +
      'data: final line\n\n',
    )
  })

  it('includes an event header when provided', () => {
    expect(formatSseFrame('complete', 'done')).toBe('event: done\ndata: complete\n\n')
  })
})