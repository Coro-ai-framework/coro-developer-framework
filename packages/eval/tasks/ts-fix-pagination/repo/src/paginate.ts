export interface Page<T> {
  /** The items on this page. */
  items: T[]
  /** The page number, starting at 1. */
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
  hasNext: boolean
  hasPrev: boolean
}

/** Return page `page` (1-based) of `items`, `pageSize` items to a page. */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  const totalItems = items.length
  const totalPages = Math.floor(totalItems / pageSize) + 1
  const start = (page - 1) * pageSize

  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    totalItems,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  }
}
