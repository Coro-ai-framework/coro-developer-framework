import { describe, expect, it } from 'vitest'
import { isRunDetailPath } from '../src/lib/jobs'
import { HOME_PATH } from '../src/lib/run-labels'
import { migrateWorkspaceTabs, pathAfterClosingTab } from '../src/lib/workspace-tabs'

describe('workspace tabs', () => {
  it('keeps only open-run paths', () => {
    expect(isRunDetailPath('/jobs/abc')).toBe(true)
    expect(isRunDetailPath('/jobs/new')).toBe(false)
    expect(isRunDetailPath('/jobs')).toBe(false)
    expect(isRunDetailPath('/')).toBe(false)
    expect(migrateWorkspaceTabs([
      { path: '/jobs/new' },
      { path: '/' },
      { path: '/jobs/abc' },
      { path: '/history' },
    ]).map(tab => tab.path)).toEqual(['/jobs/abc'])
  })

  it('closes like a browser: neighbor, then Home', () => {
    const tabs = [{ path: '/jobs/a' }, { path: '/jobs/b' }, { path: '/jobs/c' }]
    expect(pathAfterClosingTab(tabs, '/jobs/b', '/jobs/a')).toBeNull()
    expect(pathAfterClosingTab(tabs, '/jobs/a', '/jobs/a')).toBe('/jobs/b')
    expect(pathAfterClosingTab(tabs, '/jobs/c', '/jobs/c')).toBe('/jobs/b')
    expect(pathAfterClosingTab([{ path: '/jobs/a' }], '/jobs/a', '/jobs/a')).toBe(HOME_PATH)
  })
})
