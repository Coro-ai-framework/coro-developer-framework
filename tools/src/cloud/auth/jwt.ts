import { SignJWT, jwtVerify } from 'jose'
import type { CloudConfig } from '../config'

// ── Token payload types ───────────────────────────────────────────────────────

export interface AccessTokenPayload {
  sub: string          // user ID
  email: string
  teamIds: string[]    // teams this user belongs to
  type: 'access'
}

export interface RefreshTokenPayload {
  sub: string
  type: 'refresh'
}

export interface RunnerTokenPayload {
  sub: string          // token ID
  teamId: string
  type: 'runner'
}

export type TokenPayload = AccessTokenPayload | RefreshTokenPayload | RunnerTokenPayload

// ── Sign / verify ─────────────────────────────────────────────────────────────

function secretKey(config: CloudConfig): Uint8Array {
  return new TextEncoder().encode(config.jwtSecret)
}

export async function signAccessToken(
  payload: Omit<AccessTokenPayload, 'type'>,
  config: CloudConfig,
): Promise<string> {
  return new SignJWT({ ...payload, type: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(config.jwtIssuer)
    .setExpirationTime(`${config.jwtAccessTtlSeconds}s`)
    .sign(secretKey(config))
}

export async function signRefreshToken(
  userId: string,
  config: CloudConfig,
): Promise<string> {
  return new SignJWT({ sub: userId, type: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(config.jwtIssuer)
    .setExpirationTime(`${config.jwtRefreshTtlSeconds}s`)
    .sign(secretKey(config))
}

export async function signRunnerToken(
  tokenId: string,
  teamId: string,
  config: CloudConfig,
): Promise<string> {
  // Runner tokens don't expire — revocation is checked at use time
  return new SignJWT({ sub: tokenId, teamId, type: 'runner' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(config.jwtIssuer)
    .sign(secretKey(config))
}

export async function verifyToken(
  token: string,
  config: CloudConfig,
): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, secretKey(config), {
    issuer: config.jwtIssuer,
  })
  return payload as unknown as TokenPayload
}
