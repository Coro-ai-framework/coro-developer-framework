import { describe, it, expect, afterEach } from 'vitest'
import { loadCloudConfig } from '../../src/cloud/config'

describe('loadCloudConfig', () => {
  const validEnv = {
    DATABASE_URL: 'postgresql://localhost/corocloud',
    REDIS_URL: 'redis://localhost:6379',
    JWT_SECRET: 'this-is-a-test-secret-at-least-32-chars!',
  }

  afterEach(() => {
    // Clean up env vars
    for (const key of Object.keys(validEnv)) {
      delete process.env[key]
    }
    delete process.env.CLOUD_PORT
    delete process.env.JWT_ISSUER
    delete process.env.LOG_LEVEL
  })

  it('loads config from env with defaults', () => {
    Object.assign(process.env, validEnv)
    const cfg = loadCloudConfig()

    expect(cfg.databaseUrl).toBe(validEnv.DATABASE_URL)
    expect(cfg.redisUrl).toBe(validEnv.REDIS_URL)
    expect(cfg.jwtSecret).toBe(validEnv.JWT_SECRET)
    expect(cfg.port).toBe(4000)
    expect(cfg.jwtIssuer).toBe('a5labs-cloud')
    expect(cfg.jwtAccessTtlSeconds).toBe(900)
    expect(cfg.jwtRefreshTtlSeconds).toBe(604800)
    expect(cfg.logLevel).toBe('info')
  })

  it('respects custom port and issuer', () => {
    Object.assign(process.env, validEnv)
    process.env.CLOUD_PORT = '5555'
    process.env.JWT_ISSUER = 'custom-issuer'

    const cfg = loadCloudConfig()
    expect(cfg.port).toBe(5555)
    expect(cfg.jwtIssuer).toBe('custom-issuer')
  })

  it('throws on missing required fields', () => {
    // No env set
    expect(() => loadCloudConfig()).toThrow()
  })

  it('throws when JWT_SECRET is too short', () => {
    Object.assign(process.env, { ...validEnv, JWT_SECRET: 'short' })
    expect(() => loadCloudConfig()).toThrow()
  })
})
