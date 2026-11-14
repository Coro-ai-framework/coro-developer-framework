import { json } from './http'
import type { Request, Response } from './types'

export interface AppOptions {
  /** Current time in milliseconds. Defaults to `Date.now`; tests pass their own. */
  now?: () => number
}

export interface App {
  handle(request: Request): Response
}

const ITEMS = [
  { id: '1', name: 'Keyboard' },
  { id: '2', name: 'Monitor' },
  { id: '3', name: 'Desk lamp' },
]

export function createApp(options: AppOptions = {}): App {
  const now = options.now ?? Date.now
  const startedAt = now()

  return {
    handle(request) {
      const method = request.method.toUpperCase()

      if (method === 'GET' && request.path === '/health') {
        return json(200, { status: 'ok', uptimeMs: now() - startedAt })
      }
      if (method === 'GET' && request.path === '/items') {
        return json(200, { items: ITEMS })
      }
      const match = method === 'GET' ? /^\/items\/([^/]+)$/.exec(request.path) : null
      if (match) {
        const item = ITEMS.find(candidate => candidate.id === match[1])
        return item ? json(200, item) : json(404, { error: 'not_found' })
      }
      return json(404, { error: 'not_found' })
    },
  }
}
