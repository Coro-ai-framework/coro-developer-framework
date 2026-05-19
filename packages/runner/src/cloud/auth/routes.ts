// SPDX-License-Identifier: LicenseRef-Coro-Commercial-1.0

import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { eq } from 'drizzle-orm'
import type { CloudDb } from '../db/connection'
import { users, teamMembers } from '../db/schema'
import type { CloudConfig } from '../config'
import {
  signAccessToken,
  signRefreshToken,
  verifyToken,
} from './jwt'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getUserTeamIds(db: CloudDb, userId: string): Promise<string[]> {
  const rows = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId))
  return rows.map(r => r.teamId)
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function authRoutes(db: CloudDb, config: CloudConfig): Router {
  const router = Router()

  // ── Signup ────────────────────────────────────────────────────────────────

  router.post('/signup', async (req: Request, res: Response) => {
    const { email, name, password } = req.body ?? {}

    if (!email || !name || !password) {
      res.status(400).json({ error: 'email, name, and password are required' })
      return
    }

    if (typeof password !== 'string' || password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' })
      return
    }

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)

    if (existing.length > 0) {
      res.status(409).json({ error: 'Email already registered' })
      return
    }

    const id = crypto.randomUUID()
    const passwordHash = await bcrypt.hash(password, 12)

    await db.insert(users).values({ id, email, name, passwordHash })

    const teamIds = await getUserTeamIds(db, id)
    const accessToken = await signAccessToken({ sub: id, email, teamIds }, config)
    const refreshToken = await signRefreshToken(id, config)

    res.status(201).json({ user: { id, email, name }, accessToken, refreshToken })
  })

  // ── Login ─────────────────────────────────────────────────────────────────

  router.post('/login', async (req: Request, res: Response) => {
    const { email, password } = req.body ?? {}

    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' })
      return
    }

    const rows = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1)

    const user = rows[0]
    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' })
      return
    }

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' })
      return
    }

    const teamIds = await getUserTeamIds(db, user.id)
    const accessToken = await signAccessToken({ sub: user.id, email: user.email, teamIds }, config)
    const refreshToken = await signRefreshToken(user.id, config)

    res.json({
      user: { id: user.id, email: user.email, name: user.name },
      accessToken,
      refreshToken,
    })
  })

  // ── Refresh ───────────────────────────────────────────────────────────────

  router.post('/refresh', async (req: Request, res: Response) => {
    const { refreshToken } = req.body ?? {}

    if (!refreshToken) {
      res.status(400).json({ error: 'refreshToken is required' })
      return
    }

    try {
      const payload = await verifyToken(refreshToken, config)
      if (payload.type !== 'refresh') {
        res.status(401).json({ error: 'Invalid token type' })
        return
      }

      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, payload.sub))
        .limit(1)

      const user = rows[0]
      if (!user) {
        res.status(401).json({ error: 'User not found' })
        return
      }

      const teamIds = await getUserTeamIds(db, user.id)
      const accessToken = await signAccessToken({ sub: user.id, email: user.email, teamIds }, config)
      const newRefreshToken = await signRefreshToken(user.id, config)

      res.json({ accessToken, refreshToken: newRefreshToken })
    } catch {
      res.status(401).json({ error: 'Invalid or expired refresh token' })
    }
  })

  return router
}
