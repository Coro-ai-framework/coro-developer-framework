import { describe, it, expect } from 'vitest'
import { linkAbortController } from '../src/abort-link'

describe('linkAbortController', () => {
  it('returns undefined when parent signal is absent', () => {
    expect(linkAbortController(undefined)).toBeUndefined()
  })

  it('mirrors an already-aborted parent signal', () => {
    const parent = new AbortController()
    parent.abort('done')
    const linked = linkAbortController(parent.signal)
    expect(linked).toBeDefined()
    expect(linked!.signal.aborted).toBe(true)
  })

  it('aborts the linked controller when the parent aborts', () => {
    const parent = new AbortController()
    const linked = linkAbortController(parent.signal)
    expect(linked!.signal.aborted).toBe(false)
    parent.abort()
    expect(linked!.signal.aborted).toBe(true)
  })
})
