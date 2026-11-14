import { describe, expect, it } from 'vitest'
import { createApp } from '../src/index'

describe('app', () => {
  it('reports health with the time it has been up', () => {
    let time = 1_000
    const app = createApp({ now: () => time })
    time = 4_500
    const response = app.handle({ method: 'GET', path: '/health' })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok', uptimeMs: 3_500 })
  })

  it('lists items', () => {
    const response = createApp().handle({ method: 'GET', path: '/items' })
    expect(response.status).toBe(200)
    expect((response.body as { items: unknown[] }).items).toHaveLength(3)
  })

  it('returns one item', () => {
    const response = createApp().handle({ method: 'get', path: '/items/2' })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ id: '2', name: 'Monitor' })
  })

  it('returns 404 for an unknown item or route', () => {
    const app = createApp()
    expect(app.handle({ method: 'GET', path: '/items/99' }).status).toBe(404)
    expect(app.handle({ method: 'GET', path: '/nope' }).body).toEqual({ error: 'not_found' })
  })

  it('sets a JSON content type', () => {
    const response = createApp().handle({ method: 'GET', path: '/items' })
    expect(response.headers['content-type']).toBe('application/json')
  })
})
