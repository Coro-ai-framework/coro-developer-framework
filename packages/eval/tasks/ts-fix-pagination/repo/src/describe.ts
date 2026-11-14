import type { Page } from './paginate'

/** The "Showing 6-10 of 23" line under a list. */
export function describePage(page: Page<unknown>): string {
  if (page.totalItems === 0) return 'No items'
  if (page.items.length === 0) return `No items on page ${page.page}`
  const first = (page.page - 1) * page.pageSize + 1
  const last = first + page.items.length - 1
  return `Showing ${first}-${last} of ${page.totalItems}`
}
