import { HOME_PATH } from './run-labels'
import { isRunDetailPath } from './jobs'

export interface WorkspaceTabLike {
  path: string
}

/** Drop composer / list / stale paths so the bar only holds open runs. */
export function migrateWorkspaceTabs<T extends WorkspaceTabLike>(tabs: T[]): T[] {
  return tabs.filter(tab => isRunDetailPath(tab.path))
}

/**
 * Where to go after closing a tab. Inactive close stays put (`null`).
 * Last tab returns Home. Active close picks the neighbor to the right,
 * else the one to the left.
 */
export function pathAfterClosingTab(
  tabs: WorkspaceTabLike[],
  closingPath: string,
  activePath: string,
): string | null {
  if (closingPath !== activePath) return null
  const index = tabs.findIndex(tab => tab.path === closingPath)
  const remaining = tabs.filter(tab => tab.path !== closingPath)
  if (remaining.length === 0) return HOME_PATH
  const neighborIndex = Math.min(Math.max(index, 0), remaining.length - 1)
  return remaining[neighborIndex]?.path ?? HOME_PATH
}
