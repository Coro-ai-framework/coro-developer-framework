import { describe, expect, it } from 'vitest'
import { describePage, paginate } from '../src/index'

const items = Array.from({ length: 11 }, (_, i) => i + 1)

describe('paginate', () => {
  it('returns the first page', () => {
    const page = paginate(items, 1, 5)
    expect(page.items).toEqual([1, 2, 3, 4, 5])
    expect(page.totalItems).toBe(11)
    expect(page.totalPages).toBe(3)
    expect(page.hasPrev).toBe(false)
    expect(page.hasNext).toBe(true)
  })

  it('returns a partial last page', () => {
    const page = paginate(items, 3, 5)
    expect(page.items).toEqual([11])
    expect(page.hasPrev).toBe(true)
    expect(page.hasNext).toBe(false)
  })

  it('echoes the page and page size back', () => {
    const page = paginate(items, 2, 4)
    expect(page.page).toBe(2)
    expect(page.pageSize).toBe(4)
    expect(page.items).toEqual([5, 6, 7, 8])
  })
})

describe('describePage', () => {
  it('describes the range shown', () => {
    expect(describePage(paginate(items, 2, 5))).toBe('Showing 6-10 of 11')
  })

  it('describes a partial last page', () => {
    expect(describePage(paginate(items, 3, 5))).toBe('Showing 11-11 of 11')
  })

  it('says so when there is nothing at all', () => {
    expect(describePage(paginate([], 1, 5))).toBe('No items')
  })
})
