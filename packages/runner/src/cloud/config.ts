import { z } from 'zod'

const cloudConfigSchema = z.object({
  port: z.coerce.number().default(4000),
  databaseUrl: z.string().min(1),
  redisUrl: z.string().default('redis://localhost:6379'),
  jwtSecret: z.string().min(32),
  jwtIssuer: z.string().default('a5labs-cloud'),
  jwtAccessTtlSeconds: z.coerce.number().default(900),       // 15 min
  jwtRefreshTtlSeconds: z.coerce.number().default(604800),    // 7 days
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type CloudConfig = z.infer<typeof cloudConfigSchema>

export function loadCloudConfig(): CloudConfig {
  return cloudConfigSchema.parse({
    port: process.env.CLOUD_PORT,
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    jwtSecret: process.env.JWT_SECRET,
    jwtIssuer: process.env.JWT_ISSUER,
    jwtAccessTtlSeconds: process.env.JWT_ACCESS_TTL_SECONDS,
    jwtRefreshTtlSeconds: process.env.JWT_REFRESH_TTL_SECONDS,
    logLevel: process.env.LOG_LEVEL,
  })
}
