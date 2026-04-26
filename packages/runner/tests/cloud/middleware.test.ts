import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Request, Response, NextFunction } from 'express'
import { requireAuth, requireTeamMember, requireRunnerAuth } from '../../src/cloud/auth/middleware'
import { signAccessToken, signRunnerToken } from '../../src/cloud/auth/jwt'
import type { CloudConfig } from '../../src/cloud/config'

const config: CloudConfig = {
  port: 4000,
  databaseUrl: 'postgresql://localhost/test',
  redisUrl: 'redis://localhost:6379',
  jwtSecret: 'test-secret-that-is-at-least-32-chars-long!',
  jwtIssuer: 'a5labs-test',
  jwtAccessTtlSeconds: 900,
  jwtRefreshTtlSeconds: 604800,
  logLevel: 'info',
}

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    headers: {},
    params: {},
    ...overrides,
  } as unknown as Request
}

function mockRes(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  }
  return res as unknown as Response
}

describe('requireAuth middleware', () => {
  const middleware = requireAuth(config)
  let next: NextFunction

  beforeEach(() => {
    next = vi.fn()
  })

  it('rejects requests without authorization header', async () => {
    const req = mockReq()
    const res = mockRes()

    await middleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects invalid tokens', async () => {
    const req = mockReq({ headers: { authorization: 'Bearer bad-token' } })
    const res = mockRes()

    await middleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('accepts valid access tokens and populates req.user', async () => {
    const token = await signAccessToken(
      { sub: 'user-1', email: 'test@a5.dev', teamIds: ['team-a'] },
      config,
    )
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } })
    const res = mockRes()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(req.user).toBeDefined()
    expect(req.user!.sub).toBe('user-1')
    expect(req.user!.email).toBe('test@a5.dev')
  })

  it('rejects runner tokens in access-only middleware', async () => {
    const token = await signRunnerToken('tok-1', 'team-x', config)
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } })
    const res = mockRes()

    await middleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('requireTeamMember middleware', () => {
  const middleware = requireTeamMember()
  let next: NextFunction

  beforeEach(() => {
    next = vi.fn()
  })

  it('allows user who is a member of the team', () => {
    const req = mockReq({
      params: { teamId: 'team-a' } as Record<string, string>,
      user: { sub: 'user-1', email: 'test@a5.dev', teamIds: ['team-a', 'team-b'], type: 'access' as const },
    } as Partial<Request>)
    const res = mockRes()

    middleware(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('denies user who is not a member', () => {
    const req = mockReq({
      params: { teamId: 'team-c' } as Record<string, string>,
      user: { sub: 'user-1', email: 'test@a5.dev', teamIds: ['team-a'], type: 'access' as const },
    } as Partial<Request>)
    const res = mockRes()

    middleware(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 400 when teamId param is missing', () => {
    const req = mockReq({
      params: {} as Record<string, string>,
      user: { sub: 'user-1', email: 'test@a5.dev', teamIds: ['team-a'], type: 'access' as const },
    } as Partial<Request>)
    const res = mockRes()

    middleware(req, res, next)
    expect(res.status).toHaveBeenCalledWith(400)
  })
})

describe('requireRunnerAuth middleware', () => {
  const middleware = requireRunnerAuth(config)
  let next: NextFunction

  beforeEach(() => {
    next = vi.fn()
  })

  it('accepts valid runner tokens and populates req.runner', async () => {
    const token = await signRunnerToken('tok-1', 'team-x', config)
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } })
    const res = mockRes()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(req.runner).toBeDefined()
    expect(req.runner!.sub).toBe('tok-1')
    expect(req.runner!.teamId).toBe('team-x')
  })

  it('rejects access tokens in runner-only middleware', async () => {
    const token = await signAccessToken(
      { sub: 'user-1', email: 'test@a5.dev', teamIds: [] },
      config,
    )
    const req = mockReq({ headers: { authorization: `Bearer ${token}` } })
    const res = mockRes()

    await middleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })
})
