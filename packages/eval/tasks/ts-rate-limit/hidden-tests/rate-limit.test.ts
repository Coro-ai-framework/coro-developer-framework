import { describe, expect, it } from 'vitest'
import { createApp } from '../src/index'
import type { App, Response } from '../src/index'

interface Clock {
  t: number
}

function setup(limit: number, windowMs: number, start = 1_000): { app: App; clock: Clock } {
  const clock: Clock = { t: start }
  const app = createApp({ now: () => clock.t, rateLimit: { limit, windowMs } })
  return { app, clock }
}

function get(app: App, path = '/items', headers?: Record<string, string>): Response {
  return app.handle({ method: 'GET', path, headers })
}

describe('rate limiting is off unless configured', () => {
  it('never limits and adds no rate-limit headers', () => {
    const app = createApp()
    for (let i = 0; i < 50; i++) {
      const response = get(app)
      expect(response.status).toBe(200)
      expect(Object.keys(response.headers).filter(name => name.startsWith('x-ratelimit') || name === 'retry-after')).toEqual([])
    }
  })
})

describe('the limit', () => {
  it('allows `limit` requests and then answers 429', () => {
    const { app } = setup(3, 60_000)
    const statuses = [1, 2, 3, 4, 5].map(() => get(app).status)
    expect(statuses).toEqual([200, 200, 200, 429, 429])
  })

  it('reports the limit and what is left on every counted response', () => {
    const { app } = setup(3, 60_000)
    const remaining = [1, 2, 3, 4].map(() => {
      const response = get(app)
      expect(response.headers['x-ratelimit-limit']).toBe('3')
      return response.headers['x-ratelimit-remaining']
    })
    expect(remaining).toEqual(['2', '1', '0', '0'])
  })

  it('answers 429 with an error body, a JSON content type and retry-after', () => {
    const { app } = setup(1, 60_000)
    get(app)
    const response = get(app)
    expect(response.status).toBe(429)
    expect(response.body).toEqual({ error: 'rate_limited' })
    expect(response.headers['content-type']).toBe('application/json')
    expect(typeof response.headers['retry-after']).toBe('string')
  })

  it('counts requests that end in 404 and puts the headers on them', () => {
    const { app } = setup(2, 60_000)
    const first = get(app, '/nope')
    expect(first.status).toBe(404)
    expect(first.headers['x-ratelimit-remaining']).toBe('1')
    const second = get(app, '/items/99')
    expect(second.status).toBe(404)
    expect(second.headers['x-ratelimit-remaining']).toBe('0')
    expect(get(app).status).toBe(429)
  })

  it('does not touch the body of a normal response', () => {
    const { app } = setup(5, 60_000)
    const response = get(app, '/items/2')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ id: '2', name: 'Monitor' })
    expect(response.headers['content-type']).toBe('application/json')
  })
})

describe('retry-after', () => {
  it('is the time left in the window in whole seconds, rounded up', () => {
    const { app, clock } = setup(1, 10_000)
    expect(get(app).status).toBe(200) // window starts at t=1000, ends at 11000
    clock.t = 3_500
    expect(get(app).headers['retry-after']).toBe('8') // 7500ms left
    clock.t = 4_000
    expect(get(app).headers['retry-after']).toBe('7') // 7000ms left
  })

  it('is never less than one second', () => {
    const { app, clock } = setup(1, 10_000)
    get(app)
    clock.t = 10_999
    expect(get(app).headers['retry-after']).toBe('1')
  })
})

describe('the window', () => {
  it('starts at the first request and ends exactly windowMs later', () => {
    const { app, clock } = setup(1, 10_000)
    expect(get(app).status).toBe(200)
    clock.t = 10_999
    expect(get(app).status).toBe(429)
    clock.t = 11_000
    const response = get(app)
    expect(response.status).toBe(200)
    expect(response.headers['x-ratelimit-remaining']).toBe('0')
  })

  it('starts a new window at the first request after the old one ends, not on a fixed grid', () => {
    const { app, clock } = setup(2, 10_000)
    get(app) // t=1000, window 1000..11000
    clock.t = 5_000
    get(app)
    clock.t = 10_999
    expect(get(app).status).toBe(429)

    clock.t = 12_000 // new window starts here and runs to 22000
    expect(get(app).headers['x-ratelimit-remaining']).toBe('1')
    expect(get(app).headers['x-ratelimit-remaining']).toBe('0')
    clock.t = 21_999
    expect(get(app).status).toBe(429)
    clock.t = 22_000
    expect(get(app).status).toBe(200)
  })

  it('does not count rejected requests against the next window', () => {
    const { app, clock } = setup(1, 10_000)
    get(app)
    for (let i = 0; i < 20; i++) expect(get(app).status).toBe(429)
    clock.t = 11_000
    expect(get(app).status).toBe(200)
    expect(get(app).status).toBe(429)
  })
})

describe('who is a client', () => {
  it('keeps clients apart by x-api-key', () => {
    const { app } = setup(1, 60_000)
    expect(get(app, '/items', { 'x-api-key': 'a' }).status).toBe(200)
    expect(get(app, '/items', { 'x-api-key': 'a' }).status).toBe(429)
    expect(get(app, '/items', { 'x-api-key': 'b' }).status).toBe(200)
  })

  it('uses x-api-key even when x-forwarded-for differs', () => {
    const { app } = setup(1, 60_000)
    expect(get(app, '/items', { 'x-api-key': 'a', 'x-forwarded-for': '1.1.1.1' }).status).toBe(200)
    expect(get(app, '/items', { 'x-api-key': 'a', 'x-forwarded-for': '2.2.2.2' }).status).toBe(429)
  })

  it('falls back to the first address in x-forwarded-for', () => {
    const { app } = setup(1, 60_000)
    expect(get(app, '/items', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }).status).toBe(200)
    expect(get(app, '/items', { 'x-forwarded-for': ' 1.2.3.4 ' }).status).toBe(429)
    expect(get(app, '/items', { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' }).status).toBe(200)
  })

  it('treats everything without either header as one anonymous client', () => {
    const { app } = setup(1, 60_000)
    expect(get(app).status).toBe(200)
    expect(get(app, '/items', {}).status).toBe(429)
    expect(get(app, '/items', { 'x-forwarded-for': '1.2.3.4' }).status).toBe(200)
  })

  it('reads header names case-insensitively', () => {
    const { app } = setup(1, 60_000)
    expect(get(app, '/items', { 'X-API-Key': 'a' }).status).toBe(200)
    expect(get(app, '/items', { 'x-api-key': 'a' }).status).toBe(429)
    expect(get(app, '/items', { 'X-Forwarded-For': '7.7.7.7' }).status).toBe(200)
    expect(get(app, '/items', { 'x-forwarded-for': '7.7.7.7' }).status).toBe(429)
  })
})

describe('/health', () => {
  it('is never limited and never counted', () => {
    const { app } = setup(1, 60_000)
    for (let i = 0; i < 5; i++) expect(get(app, '/health').status).toBe(200)

    const first = get(app)
    expect(first.status).toBe(200)
    expect(first.headers['x-ratelimit-remaining']).toBe('0')
    expect(get(app).status).toBe(429)

    expect(get(app, '/health').status).toBe(200)
  })
})
