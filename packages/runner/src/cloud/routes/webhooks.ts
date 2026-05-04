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
import { PostgresStateBackend } from '../db/postgres-backend'
import type { WsEventWebhook } from '../../state/ws-protocol'
import { extractBbPrId, extractJiraTicketId } from '../../jobs/webhook-payload'

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

// ── Routing helper ────────────────────────────────────────────────────────────

/**
 * Look up the team's job that owns the inbound event (by PR id or issue
 * key) and route the WS frame to the most specific recipient available:
 *
 *   1. The runner currently running that job (precise — multi-runner safe).
 *   2. Any other connected team runner (broadcast — single-runner case or
 *      job is parked on a runner that's not actively reporting it via
 *      heartbeat).
 *   3. The team's offline queue (delivered on reconnect).
 *
 * Returns the route taken so handlers can emit useful diagnostics.
 *
 * Looking the job up in the cloud (rather than letting the runner do it
 * after delivery) lets us pick the right runner up front. The runner-side
 * dispatcher still re-resolves the PR id → job mapping defensively, so a
 * miss here only costs precision, never correctness.
 */
async function routeWebhookToTeam(
  ctx: WebhookContext,
  teamId: string,
  jobId: string | null,
  event: WsEventWebhook,
): Promise<{ delivered: boolean; route: 'job' | 'team' | 'queued' }> {
  if (jobId) {
    return ctx.gateway.sendToJobOrTeam(teamId, jobId, event)
  }
  const delivered = ctx.gateway.sendToTeam(teamId, event)
  return { delivered, route: delivered ? 'team' : 'queued' }
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function webhookRoutes(ctx: WebhookContext): Router {
  const router = Router()

  // Use raw body parsing for HMAC verification
  router.use(express.raw({ type: 'application/json' }))

  // ── BitBucket webhook ────────────────────────────────────────────────────

  router.post('/bitbucket/:teamId', async (req: Request, res: Response) => {
    const teamId = p(req, 'teamId')
    const { logger, db } = ctx

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

    // Resolve the job that owns this PR (if any) so we can route to the
    // exact runner that's running it. Lookup failures are non-fatal —
    // we fall back to team broadcast so the event still reaches a runner.
    const prId = extractBbPrId(payload)
    let jobId: string | null = null
    if (prId !== null) {
      try {
        const backend = new PostgresStateBackend(db, teamId)
        const job = await backend.getJobByPr(prId)
        jobId = job?.id ?? null
      } catch (err) {
        logger.warn({ err, teamId, prId }, 'PR → job lookup failed — falling back to team broadcast')
      }
    }

    const result = await routeWebhookToTeam(ctx, teamId, jobId, event)
    if (result.route === 'queued') {
      logger.info({ teamId }, 'No runner online — event queued')
    } else {
      logger.debug({ teamId, jobId, route: result.route }, 'BitBucket webhook routed')
    }

    res.status(200).json({ received: true, delivered: result.delivered, route: result.route })
  })

  // ── GitHub webhook ───────────────────────────────────────────────────────

  router.post('/github/:teamId', async (req: Request, res: Response) => {
    const teamId = p(req, 'teamId')
    const { logger, db } = ctx

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

    // GitHub payloads use a different shape (`pull_request.number`) — full
    // normalisation lands in P2. For now we forward as-is so the runner can
    // ignore unknown shapes; routing falls back to team broadcast.
    const event: WsEventWebhook = {
      type: 'event:webhook',
      event: {
        source: 'bitbucket', // TODO(P2): add 'github' source + normalisation
        eventKey,
        payload,
        receivedAt: new Date().toISOString(),
      },
    }

    const result = await routeWebhookToTeam(ctx, teamId, null, event)
    res.status(200).json({ received: true, delivered: result.delivered, route: result.route })
  })

  // ── Jira webhook ─────────────────────────────────────────────────────────

  router.post('/jira/:teamId', async (req: Request, res: Response) => {
    const teamId = p(req, 'teamId')
    const { logger, db } = ctx

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

    // Resolve the job by issue key (if any) and route precisely.
    const ticketId = extractJiraTicketId(payload)
    let jobId: string | null = null
    if (ticketId) {
      try {
        const backend = new PostgresStateBackend(db, teamId)
        const job = await backend.getJobByJiraTicket(ticketId)
        jobId = job?.id ?? null
      } catch (err) {
        logger.warn({ err, teamId, ticketId }, 'Jira → job lookup failed — falling back to team broadcast')
      }
    }

    const result = await routeWebhookToTeam(ctx, teamId, jobId, event)
    res.status(200).json({ received: true, delivered: result.delivered, route: result.route })
  })

  return router
}
