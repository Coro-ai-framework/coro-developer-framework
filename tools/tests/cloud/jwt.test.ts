import { describe, it, expect } from 'vitest'
import {
  signAccessToken,
  signRefreshToken,
  signRunnerToken,
  verifyToken,
} from '../../src/cloud/auth/jwt'
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

describe('JWT module', () => {
  describe('signAccessToken + verifyToken', () => {
    it('roundtrips an access token', async () => {
      const token = await signAccessToken(
        { sub: 'user-1', email: 'test@a5.dev', teamIds: ['team-a', 'team-b'] },
        config,
      )

      const payload = await verifyToken(token, config)
      expect(payload.type).toBe('access')
      expect(payload.sub).toBe('user-1')

      if (payload.type === 'access') {
        expect(payload.email).toBe('test@a5.dev')
        expect(payload.teamIds).toEqual(['team-a', 'team-b'])
      }
    })

    it('rejects tokens signed with a different secret', async () => {
      const token = await signAccessToken(
        { sub: 'user-1', email: 'test@a5.dev', teamIds: [] },
        config,
      )

      const badConfig = { ...config, jwtSecret: 'wrong-secret-that-is-at-least-32-chars!!' }
      await expect(verifyToken(token, badConfig)).rejects.toThrow()
    })

    it('rejects tokens with wrong issuer', async () => {
      const token = await signAccessToken(
        { sub: 'user-1', email: 'test@a5.dev', teamIds: [] },
        config,
      )

      const badConfig = { ...config, jwtIssuer: 'wrong-issuer' }
      await expect(verifyToken(token, badConfig)).rejects.toThrow()
    })
  })

  describe('signRefreshToken', () => {
    it('roundtrips a refresh token', async () => {
      const token = await signRefreshToken('user-1', config)
      const payload = await verifyToken(token, config)

      expect(payload.type).toBe('refresh')
      expect(payload.sub).toBe('user-1')
    })
  })

  describe('signRunnerToken', () => {
    it('roundtrips a runner token', async () => {
      const token = await signRunnerToken('token-id-1', 'team-x', config)
      const payload = await verifyToken(token, config)

      expect(payload.type).toBe('runner')
      expect(payload.sub).toBe('token-id-1')

      if (payload.type === 'runner') {
        expect(payload.teamId).toBe('team-x')
      }
    })
  })

  describe('expired tokens', () => {
    it('rejects expired access tokens', async () => {
      const shortConfig = { ...config, jwtAccessTtlSeconds: 0 }
      const token = await signAccessToken(
        { sub: 'user-1', email: 'test@a5.dev', teamIds: [] },
        shortConfig,
      )

      // Token with 0s TTL is already expired
      await expect(verifyToken(token, shortConfig)).rejects.toThrow()
    })
  })
})
