import Redis from 'ioredis'

/** Dedicated DB index so integration tests never wipe application data on DB 0. */
export const TEST_REDIS_DB = 15

export interface TestRedisOptions {
  /** Override host (default 127.0.0.1) */
  host?: string
  /** Override port (default 6379) */
  port?: number
  /** Full URL wins over host/port when set (e.g. redis://localhost:6379) */
  url?: string
}

/**
 * Creates a Redis client for integration tests.
 * Always uses DB index {@link TEST_REDIS_DB} so `flushdb` never touches app data on DB 0.
 */
export function createTestRedis(options: TestRedisOptions = {}): Redis {
  const url = options.url ?? process.env.REDIS_URL
  if (url) {
    return new Redis(url, {
      db: TEST_REDIS_DB,
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    })
  }
  return new Redis({
    host: options.host ?? process.env.REDIS_HOST ?? '127.0.0.1',
    port: options.port ?? parseInt(process.env.REDIS_PORT ?? '6379', 10),
    db: TEST_REDIS_DB,
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  })
}

export async function flushTestRedis(redis: Redis): Promise<void> {
  await redis.flushdb()
}
