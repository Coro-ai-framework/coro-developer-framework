import { describe, expect, it } from 'vitest'
import { describePage, paginate } from '../src/index'

const numbers = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1)

describe('paginate: an exact multiple of the page size', () => {
  it('reports no extra empty page', () => {
    expect(paginate(numbers(10), 1, 5).totalPages).toBe(2)
    expect(paginate(numbers(5), 1, 5).totalPages).toBe(1)
    expect(paginate(numbers(15), 1, 5).totalPages).toBe(3)
  })

  it('has no next page from the real last page', () => {
    const page = paginate(numbers(10), 2, 5)
    expect(page.items).toEqual([6, 7, 8, 9, 10])
    expect(page.hasNext).toBe(false)
    expect(page.hasPrev).toBe(true)
  })

  it('still has a next page from the first of two', () => {
    const page = paginate(numbers(10), 1, 5)
    expect(page.hasNext).toBe(true)
    expect(page.hasPrev).toBe(false)
  })
})

describe('paginate: not an exact multiple', () => {
  it('rounds the page count up', () => {
    expect(paginate(numbers(11), 1, 5).totalPages).toBe(3)
    expect(paginate(numbers(1), 1, 5).totalPages).toBe(1)
    expect(paginate(numbers(6), 1, 5).totalPages).toBe(2)
  })
})

describe('paginate: no items', () => {
  it('has no pages and nowhere to go', () => {
    const page = paginate([], 1, 5)
    expect(page.items).toEqual([])
    expect(page.totalItems).toBe(0)
    expect(page.totalPages).toBe(0)
    expect(page.hasNext).toBe(false)
    expect(page.hasPrev).toBe(false)
  })
})

describe('paginate: a page past the end', () => {
  it('is allowed and empty', () => {
    const page = paginate(numbers(10), 5, 5)
    expect(page.items).toEqual([])
    expect(page.hasNext).toBe(false)
    expect(page.hasPrev).toBe(true)
    expect(page.totalPages).toBe(2)
  })
})

describe('paginate: invalid arguments', () => {
  it('rejects a page size that is not a positive whole number', () => {
    expect(() => paginate(numbers(10), 1, 0)).toThrow(RangeError)
    expect(() => paginate(numbers(10), 1, -5)).toThrow(RangeError)
    expect(() => paginate(numbers(10), 1, 2.5)).toThrow(RangeError)
    expect(() => paginate(numbers(10), 1, Number.NaN)).toThrow(RangeError)
  })

  it('rejects a page that is not a positive whole number', () => {
    expect(() => paginate(numbers(10), 0, 5)).toThrow(RangeError)
    expect(() => paginate(numbers(10), -1, 5)).toThrow(RangeError)
    expect(() => paginate(numbers(10), 1.5, 5)).toThrow(RangeError)
    expect(() => paginate(numbers(10), Number.NaN, 5)).toThrow(RangeError)
  })

  it('rejects them even when there are no items', () => {
    expect(() => paginate([], 1, 0)).toThrow(RangeError)
  })
})

describe('describePage', () => {
  it('describes the last page of an exact multiple', () => {
    expect(describePage(paginate(numbers(10), 2, 5))).toBe('Showing 6-10 of 10')
  })

  it('still describes an empty list and a page past the end', () => {
    expect(describePage(paginate([], 1, 5))).toBe('No items')
    expect(describePage(paginate(numbers(10), 4, 5))).toBe('No items on page 4')
  })
})
