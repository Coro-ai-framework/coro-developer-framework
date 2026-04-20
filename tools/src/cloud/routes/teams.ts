import { Router, Request, Response } from 'express'
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { eq, and } from 'drizzle-orm'
import type { CloudDb } from '../db/connection'
import { teams, teamMembers, runnerTokens } from '../db/schema'
import type { CloudConfig } from '../config'
import { requireAuth, requireTeamMember } from '../auth/middleware'
import { signRunnerToken } from '../auth/jwt'

/** Extract a route param safely (Express v5 types params as string | string[]) */
function p(req: Request, name: string): string {
  const v = req.params[name]
  return Array.isArray(v) ? v[0] : v
}

export function teamRoutes(db: CloudDb, config: CloudConfig): Router {
  const router = Router()
  const auth = requireAuth(config)
  const member = requireTeamMember()

  // ── List teams for current user ────────────────────────────────────────────

  router.get('/', auth, async (req: Request, res: Response) => {
    const rows = await db
      .select({
        id: teams.id,
        name: teams.name,
        slug: teams.slug,
        role: teamMembers.role,
        createdAt: teams.createdAt,
      })
      .from(teamMembers)
      .innerJoin(teams, eq(teamMembers.teamId, teams.id))
      .where(eq(teamMembers.userId, req.user!.sub))

    res.json(rows)
  })

  // ── Create team ───────────────────────────────────────────────────────────

  router.post('/', auth, async (req: Request, res: Response) => {
    const { name, slug } = req.body ?? {}

    if (!name || !slug) {
      res.status(400).json({ error: 'name and slug are required' })
      return
    }

    if (!/^[a-z0-9-]+$/.test(slug)) {
      res.status(400).json({ error: 'slug must be lowercase alphanumeric with hyphens' })
      return
    }

    const existing = await db
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.slug, slug))
      .limit(1)

    if (existing.length > 0) {
      res.status(409).json({ error: 'Team slug already taken' })
      return
    }

    const id = crypto.randomUUID()
    await db.insert(teams).values({ id, name, slug })

    // Creator becomes admin
    await db.insert(teamMembers).values({
      teamId: id,
      userId: req.user!.sub,
      role: 'admin',
      joinedAt: new Date(),
    })

    res.status(201).json({ id, name, slug })
  })

  // ── Get team details ──────────────────────────────────────────────────────

  router.get('/:teamId', auth, member, async (req: Request, res: Response) => {
    const rows = await db
      .select()
      .from(teams)
      .where(eq(teams.id, p(req, 'teamId')))
      .limit(1)

    const team = rows[0]
    if (!team) {
      res.status(404).json({ error: 'Team not found' })
      return
    }

    const members = await db
      .select({
        userId: teamMembers.userId,
        role: teamMembers.role,
        joinedAt: teamMembers.joinedAt,
      })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, p(req, 'teamId')))

    res.json({ ...team, members })
  })

  // ── Add member ────────────────────────────────────────────────────────────

  router.post('/:teamId/members', auth, member, async (req: Request, res: Response) => {
    const { userId, role } = req.body ?? {}

    if (!userId) {
      res.status(400).json({ error: 'userId is required' })
      return
    }

    const existing = await db
      .select()
      .from(teamMembers)
      .where(and(
        eq(teamMembers.teamId, p(req, 'teamId')),
        eq(teamMembers.userId, userId),
      ))
      .limit(1)

    if (existing.length > 0) {
      res.status(409).json({ error: 'User is already a member' })
      return
    }

    await db.insert(teamMembers).values({
      teamId: p(req, 'teamId'),
      userId,
      role: role === 'admin' ? 'admin' : 'member',
      joinedAt: new Date(),
    })

    res.status(201).json({ teamId: p(req, 'teamId'), userId, role: role ?? 'member' })
  })

  // ── Remove member ─────────────────────────────────────────────────────────

  router.delete('/:teamId/members/:userId', auth, member, async (req: Request, res: Response) => {
    await db
      .delete(teamMembers)
      .where(and(
        eq(teamMembers.teamId, p(req, 'teamId')),
        eq(teamMembers.userId, p(req, 'userId')),
      ))

    res.status(204).end()
  })

  // ── Generate runner token ─────────────────────────────────────────────────

  router.post('/:teamId/runner-tokens', auth, member, async (req: Request, res: Response) => {
    const { name } = req.body ?? {}

    if (!name) {
      res.status(400).json({ error: 'name is required' })
      return
    }

    const id = crypto.randomUUID()
    const rawToken = `a5rt_${crypto.randomBytes(32).toString('hex')}`
    const tokenHash = await bcrypt.hash(rawToken, 10)

    await db.insert(runnerTokens).values({
      id,
      teamId: p(req, 'teamId'),
      name,
      tokenHash,
    })

    // Sign a JWT containing the token ID + team — this is what the runner stores
    const jwt = await signRunnerToken(id, p(req, 'teamId'), config)

    res.status(201).json({ id, name, token: jwt })
  })

  // ── List runner tokens ────────────────────────────────────────────────────

  router.get('/:teamId/runner-tokens', auth, member, async (req: Request, res: Response) => {
    const tokens = await db
      .select({
        id: runnerTokens.id,
        name: runnerTokens.name,
        lastUsedAt: runnerTokens.lastUsedAt,
        createdAt: runnerTokens.createdAt,
        revokedAt: runnerTokens.revokedAt,
      })
      .from(runnerTokens)
      .where(eq(runnerTokens.teamId, p(req, 'teamId')))

    res.json(tokens)
  })

  // ── Revoke runner token ───────────────────────────────────────────────────

  router.delete('/:teamId/runner-tokens/:tokenId', auth, member, async (req: Request, res: Response) => {
    await db
      .update(runnerTokens)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(runnerTokens.id, p(req, 'tokenId')),
        eq(runnerTokens.teamId, p(req, 'teamId')),
      ))

    res.status(204).end()
  })

  return router
}
