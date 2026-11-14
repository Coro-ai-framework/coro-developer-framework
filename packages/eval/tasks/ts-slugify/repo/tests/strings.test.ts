import { describe, expect, it } from 'vitest'
import { capitalize, truncate } from '../src/index'

describe('capitalize', () => {
  it('upper-cases the first character', () => {
    expect(capitalize('hello')).toBe('Hello')
  })

  it('leaves the rest alone', () => {
    expect(capitalize('hELLO')).toBe('HELLO')
  })

  it('returns an empty string unchanged', () => {
    expect(capitalize('')).toBe('')
  })
})

describe('truncate', () => {
  it('returns short text unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('cuts long text and ends with an ellipsis', () => {
    expect(truncate('hello world', 6)).toBe('hello…')
  })

  it('returns an empty string for a non-positive limit', () => {
    expect(truncate('hello', 0)).toBe('')
  })
})
