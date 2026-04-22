// ── Webhook routes ────────────────────────────────────────────────────────────
//
// Per-team webhook endpoints for BitBucket, GitHub, and Jira.
// Receives webhook payloads, validates HMAC, looks up the target job,
// and forwards the event to the correct runner via WebSocket.

import crypto from 'crypto'
import { Router, Request, Response } from 'express'
import express from 'express'
import { eq, and } from 'drizzle-orm'
import { Logger } from 'pino'
import type { CloudDb } from '../db/connection'
import * as schema from '../db/schema'
import { WsGateway } from '../ws/gateway'
import type { WsEventWebhook } from '../../state/ws-protocol'

export interface WebhookContext {
  db: CloudDb
  gateway: WsGateway
  logger: Logger
}

/** Extract a route param safely (Express v5 types params as string | string[]) */
function p(req: Request, name: string): string {
  const v = req.params[name]
  return Array.isArray(v) ? v[0] : v
}

// ── HMAC verification ─────────────────────────────────────────────────────────

function verifyHmac(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false

  const hmac = crypto.createHmac('sha256', secret)
  hmac.update(rawBody)
  const expected = `sha256=${hmac.digest('hex')}`

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader),
      Buffer.from(expected),
    )
  } catch {
    return false
  }
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function webhookRoutes(ctx: WebhookContext): Router {
  const router = Router()

  // Use raw body parsing for HMAC verification
  router.use(express.raw({ type: 'application/json' }))

  // ── BitBucket webhook ────────────────────────────────────────────────────

  router.post('/bitbucket/:teamId', async (req: Request, res: Response) => {
    const teamId = p(req, 'teamId')
    const { logger, db, gateway } = ctx

    // Look up webhook secret for this team
    const [config] = await db
      .select()
      .from(schema.webhookConfigs)
      .where(and(
        eq(schema.webhookConfigs.teamId, teamId),
        eq(schema.webhookConfigs.provider, 'bitbucket'),
      ))

    if (!config) {
      logger.warn({ teamId }, 'No BitBucket webhook config for team')
      res.status(404).json({ error: 'Webhook not configured for this team' })
      return
    }

    // Verify HMAC
    const signature = req.headers['x-hub-signature'] as string | undefined
    const rawBody = req.body as Buffer
    if (!verifyHmac(rawBody, signature, config.secret)) {
      logger.warn({ teamId }, 'BitBucket webhook HMAC verification failed')
      res.status(401).json({ error: 'Invalid signature' })
      return
    }

    const payload = JSON.parse(rawBody.toString())
    const eventKey = req.headers['x-event-key'] as string || 'unknown'

    logger.info({ teamId, eventKey }, 'BitBucket webhook received')

    const event: WsEventWebhook = {
      type: 'event:webhook',
      event: {
        source: 'bitbucket',
        eventKey,
        payload,
        receivedAt: new Date().toISOString(),
      },
    }

    const delivered = gateway.sendToTeam(teamId, event)
    if (!delivered) {
      logger.info({ teamId }, 'No runner online — event queued')
    }

    res.status(200).json({ received: true, delivered })
  })

  // ── GitHub webhook ───────────────────────────────────────────────────────

  router.post('/github/:teamId', async (req: Request, res: Response) => {
    const teamId = p(req, 'teamId')
    const { logger, db, gateway } = ctx

    const [config] = await db
      .select()
      .from(schema.webhookConfigs)
      .where(and(
        eq(schema.webhookConfigs.teamId, teamId),
        eq(schema.webhookConfigs.provider, 'github'),
      ))

    if (!config) {
      res.status(404).json({ error: 'Webhook not configured for this team' })
      return
    }

    // GitHub uses X-Hub-Signature-256
    const signature = req.headers['x-hub-signature-256'] as string | undefined
    const rawBody = req.body as Buffer
    if (!verifyHmac(rawBody, signature, config.secret)) {
      logger.warn({ teamId }, 'GitHub webhook HMAC verification failed')
      res.status(401).json({ error: 'Invalid signature' })
      return
    }

    const payload = JSON.parse(rawBody.toString())
    const eventKey = req.headers['x-github-event'] as string || 'unknown'

    logger.info({ teamId, eventKey }, 'GitHub webhook received')

    const event: WsEventWebhook = {
      type: 'event:webhook',
      event: {
        source: 'bitbucket', // GitHub will be added as a source type later
        eventKey,
        payload,
        receivedAt: new Date().toISOString(),
      },
    }

    const delivered = gateway.sendToTeam(teamId, event)
    res.status(200).json({ received: true, delivered })
  })

  // ── Jira webhook ─────────────────────────────────────────────────────────

  router.post('/jira/:teamId', async (req: Request, res: Response) => {
    const teamId = p(req, 'teamId')
    const { logger, db, gateway } = ctx

    const [config] = await db
      .select()
      .from(schema.webhookConfigs)
      .where(and(
        eq(schema.webhookConfigs.teamId, teamId),
        eq(schema.webhookConfigs.provider, 'jira'),
      ))

    if (!config) {
      res.status(404).json({ error: 'Webhook not configured for this team' })
      return
    }

    // Jira webhooks don't have HMAC — validated by secret in URL path (future)
    const rawBody = req.body as Buffer
    const payload = JSON.parse(rawBody.toString())
    const eventKey = payload.webhookEvent ?? payload.issue_event_type_name ?? 'unknown'

    logger.info({ teamId, eventKey }, 'Jira webhook received')

    const event: WsEventWebhook = {
      type: 'event:webhook',
      event: {
        source: 'jira',
        eventKey: eventKey as string,
        payload,
        receivedAt: new Date().toISOString(),
      },
    }

    const delivered = gateway.sendToTeam(teamId, event)
    res.status(200).json({ received: true, delivered })
  })

  return router
}
