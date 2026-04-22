import { Request, Response, NextFunction } from 'express'
import { verifyToken, AccessTokenPayload, RunnerTokenPayload } from './jwt'
import type { CloudConfig } from '../config'

// ── Augment Express Request ───────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      /** Populated after requireAuth middleware */
      user?: AccessTokenPayload
      /** Populated after requireRunnerAuth middleware */
      runner?: RunnerTokenPayload
    }
  }
}

// ── Middleware factories ──────────────────────────────────────────────────────

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) return null
  return header.slice(7)
}

/**
 * Requires a valid access token. Populates `req.user`.
 */
export function requireAuth(config: CloudConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = extractBearer(req)
    if (!token) {
      res.status(401).json({ error: 'Missing authorization header' })
      return
    }

    try {
      const payload = await verifyToken(token, config)
      if (payload.type !== 'access') {
        res.status(401).json({ error: 'Invalid token type' })
        return
      }
      req.user = payload
      next()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.debug('[auth] Token verification failed:', message)
      res.status(401).json({ error: 'Invalid or expired token' })
    }
  }
}

/**
 * Requires the user to be a member of the team identified by `:teamId` param.
 * Must be used AFTER `requireAuth`.
 */
export function requireTeamMember() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const teamId = req.params.teamId
    const teamIdStr = Array.isArray(teamId) ? teamId[0] : teamId
    if (!teamIdStr) {
      res.status(400).json({ error: 'Missing teamId parameter' })
      return
    }
    if (!req.user?.teamIds.includes(teamIdStr)) {
      res.status(403).json({ error: 'Not a member of this team' })
      return
    }
    next()
  }
}

/**
 * Requires a valid runner token. Populates `req.runner`.
 */
export function requireRunnerAuth(config: CloudConfig) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = extractBearer(req)
    if (!token) {
      res.status(401).json({ error: 'Missing authorization header' })
      return
    }

    try {
      const payload = await verifyToken(token, config)
      if (payload.type !== 'runner') {
        res.status(401).json({ error: 'Invalid token type — runner token required' })
        return
      }
      req.runner = payload
      next()
    } catch {
      res.status(401).json({ error: 'Invalid or expired runner token' })
    }
  }
}
