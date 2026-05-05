// ── Webhook routes ────────────────────────────────────────────────────────────
//
// Per-team webhook endpoints. P4 collapsed every legacy provider-named
// route (`/webhook/bitbucket/:teamId`, …) into a single generic
// `POST /webhook/:teamId/:pluginId`. Provider knowledge belongs in
// the runner-side plugin's `normalizeInbound`; the cloud is now an
// authentication & relay layer:
//
//   1. Look up `tenant_plugin_webhooks(teamId, pluginId)` for HMAC
//      configuration (algorithm, header, secret, format).
//   2. Verify the request signature using whatever scheme the row
//      describes — every plugin author declares this in their
//      manifest's `webhook` block, so the cloud doesn't need a
//      per-provider switch statement.
//   3. Forward `{ pluginId, headers, rawBodyBase64 }` over WS to the
//      runner that owns the team's parked job, falling back to a
//      team-wide broadcast or offline queue.
//
// The legacy per-provider routes still exist for one release
// (P9 removes them) but only as thin redirects into the generic path.

import crypto from 'crypto'
import { Router, Request, Response } from 'express'
import express from 'express'
import { eq, and } from 'drizzle-orm'
import { Logger } from 'pino'
import type { CloudDb } from '../db/connection'
import * as schema from '../db/schema'
import { WsGateway } from '../ws/gateway'
import { PostgresStateBackend } from '../db/postgres-backend'
import type { WsEventPluginWebhook } from '../../state/ws-protocol'

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

// ── HMAC verification (algo-agnostic) ─────────────────────────────────────────

/**
 * Compute the digest for an HMAC algorithm, returning the bytes for
 * timing-safe comparison. Returns `null` for `'none'` (no HMAC, the
 * caller handles that branch separately).
 */
function digestFor(algorithm: string, rawBody: Buffer, secret: string): Buffer | null {
  switch (algorithm) {
    case 'hmac-sha256':
      return crypto.createHmac('sha256', secret).update(rawBody).digest()
    case 'hmac-sha1':
      return crypto.createHmac('sha1', secret).update(rawBody).digest()
    case 'none':
      return null
    default:
      return null
  }
}

/**
 * Render the expected wire-format string for an HMAC digest. Mirrors
 * the per-plugin `webhook.format` field (`'sha256=<hex>'`,
 * `'sha1=<hex>'`, `'<hex>'`, `'<plain>'`). For `'<plain>'` the
 * verifier just compares the header value to the secret directly.
 */
function expectedSignature(format: string, digest: Buffer | null, secret: string): string {
  switch (format) {
    case 'sha256=<hex>':
      return `sha256=${digest!.toString('hex')}`
    case 'sha1=<hex>':
      return `sha1=${digest!.toString('hex')}`
    case '<hex>':
      return digest!.toString('hex')
    case '<plain>':
      return secret
    default:
      return ''
  }
}

interface PluginWebhookConfig {
  algorithm: string
  header: string
  secret: string
  format: string
}

/**
 * Generic verifier. Returns `true` when the request authenticates,
 * `false` otherwise. `algorithm: 'none'` short-circuits to `true` —
 * those plugins rely on the URL-embedded secret + tenant-scoped
 * routing for authenticity (Atlassian's webhook variant, for
 * example).
 */
function verifyRequest(rawBody: Buffer, headers: Record<string, string>, cfg: PluginWebhookConfig): boolean {
  if (cfg.algorithm === 'none') return true

  const provided = headers[cfg.header.toLowerCase()]
  if (!provided) return false

  const digest = digestFor(cfg.algorithm, rawBody, cfg.secret)
  if (!digest) return false

  const expected = expectedSignature(cfg.format, digest, cfg.secret)
  try {
    const a = Buffer.from(provided)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

// ── Config lookup ────────────────────────────────────────────────────────────
//
// New shape: `tenant_plugin_webhooks(teamId, pluginId)` is the
// canonical location. For one release we also fall back to the
// legacy `webhook_configs(teamId, provider)` table so existing
// tenants keep working without a forced migration. P9 drops the
// legacy table.

async function loadPluginWebhookConfig(
  db: CloudDb,
  teamId: string,
  pluginId: string,
): Promise<PluginWebhookConfig | null> {
  const [primary] = await db
    .select()
    .from(schema.tenantPluginWebhooks)
    .where(and(
      eq(schema.tenantPluginWebhooks.teamId, teamId),
      eq(schema.tenantPluginWebhooks.pluginId, pluginId),
    ))
  if (primary) {
    return {
      algorithm: primary.algorithm,
      header: primary.header,
      secret: primary.secret,
      format: primary.format,
    }
  }

  // Legacy fallback. The deprecated `webhook_configs.provider` enum
  // happened to use the same id strings for Bitbucket / GitHub / Jira
  // we now use as `pluginId`, so the lookup is a 1:1 map. Any new
  // plugin only writes to the new table.
  if (pluginId === 'bitbucket' || pluginId === 'github' || pluginId === 'jira') {
    const [legacy] = await db
      .select()
      .from(schema.webhookConfigs)
      .where(and(
        eq(schema.webhookConfigs.teamId, teamId),
        eq(schema.webhookConfigs.provider, pluginId),
      ))
    if (legacy) {
      return {
        algorithm: pluginId === 'jira' ? 'none' : 'hmac-sha256',
        header:
          pluginId === 'github' ? 'x-hub-signature-256' :
          pluginId === 'bitbucket' ? 'x-hub-signature' :
          'authorization',
        secret: legacy.secret,
        format:
          pluginId === 'github' ? 'sha256=<hex>' :
          pluginId === 'bitbucket' ? 'sha256=<hex>' :
          '<plain>',
      }
    }
  }

  return null
}

// ── Routing helper ────────────────────────────────────────────────────────────

async function routeToTeam(
  ctx: WebhookContext,
  teamId: string,
  jobId: string | null,
  event: WsEventPluginWebhook,
): Promise<{ delivered: boolean; route: 'job' | 'team' | 'queued' }> {
  if (jobId) return ctx.gateway.sendToJobOrTeam(teamId, jobId, event)
  const delivered = ctx.gateway.sendToTeam(teamId, event)
  return { delivered, route: delivered ? 'team' : 'queued' }
}

// ── Best-effort job lookup (avoids team-wide broadcast when possible) ─────────
//
// The cloud doesn't run plugin runtimes, so it can't call
// `normalizeInbound` to extract the ExternalRef. To still route
// precisely, we sniff well-known shapes for the two builtin
// providers: PR id for Bitbucket/GitHub, ticket key for Jira.
// External plugins fall through to team-wide broadcast — the runner
// will resolve the ref when the plugin normalises the payload, so
// correctness is preserved either way.

function sniffPrId(payload: Record<string, unknown>): number | null {
  const pr = payload['pullrequest'] as Record<string, unknown> | undefined
  const id = pr?.['id']
  if (typeof id === 'number') return id
  if (typeof id === 'string') {
    const n = parseInt(id, 10)
    return Number.isNaN(n) ? null : n
  }
  // GitHub shape
  const ghPr = payload['pull_request'] as Record<string, unknown> | undefined
  const number = ghPr?.['number']
  if (typeof number === 'number') return number
  return null
}

function sniffJiraKey(payload: Record<string, unknown>): string | null {
  const issue = payload['issue'] as Record<string, unknown> | undefined
  const key = issue?.['key']
  return typeof key === 'string' ? key : null
}

async function resolveJobId(
  ctx: WebhookContext,
  teamId: string,
  pluginId: string,
  rawBody: Buffer,
): Promise<string | null> {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>
  } catch {
    return null
  }

  try {
    const backend = new PostgresStateBackend(ctx.db, teamId)

    if (pluginId === 'bitbucket' || pluginId === 'github') {
      const prId = sniffPrId(payload)
      if (prId === null) return null
      const job = await backend.getJobByPr(prId)
      return job?.id ?? null
    }
    if (pluginId === 'jira') {
      const ticketId = sniffJiraKey(payload)
      if (!ticketId) return null
      const job = await backend.getJobByJiraTicket(ticketId)
      return job?.id ?? null
    }
  } catch (err) {
    ctx.logger.warn({ err, teamId, pluginId }, 'Job-id sniff failed — falling back to team broadcast')
  }
  return null
}

// ── Header collection ────────────────────────────────────────────────────────

function collectHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v
    else if (Array.isArray(v) && v.length > 0) out[k.toLowerCase()] = v[0]
  }
  return out
}

// ── Generic handler ──────────────────────────────────────────────────────────
//
// Single code path used by both the new generic route and the legacy
// per-provider compat redirects. Everything goes through here so the
// HMAC scheme stays plugin-driven.

async function handlePluginWebhook(
  ctx: WebhookContext,
  teamId: string,
  pluginId: string,
  req: Request,
  res: Response,
): Promise<void> {
  const cfg = await loadPluginWebhookConfig(ctx.db, teamId, pluginId)
  if (!cfg) {
    ctx.logger.warn({ teamId, pluginId }, 'No webhook config for plugin')
    res.status(404).json({ error: 'Webhook not configured for this team/plugin' })
    return
  }

  const rawBody = req.body as Buffer
  const headers = collectHeaders(req)

  if (!verifyRequest(rawBody, headers, cfg)) {
    ctx.logger.warn({ teamId, pluginId }, 'Plugin webhook signature verification failed')
    res.status(401).json({ error: 'Invalid signature' })
    return
  }

  ctx.logger.info({ teamId, pluginId }, 'Plugin webhook received')

  const event: WsEventPluginWebhook = {
    type: 'event:pluginWebhook',
    pluginId,
    headers,
    rawBodyBase64: rawBody.toString('base64'),
    receivedAt: new Date().toISOString(),
  }

  const jobId = await resolveJobId(ctx, teamId, pluginId, rawBody)
  const result = await routeToTeam(ctx, teamId, jobId, event)
  if (result.route === 'queued') {
    ctx.logger.info({ teamId, pluginId }, 'No runner online — event queued')
  } else {
    ctx.logger.debug({ teamId, pluginId, jobId, route: result.route }, 'Plugin webhook routed')
  }

  res.status(200).json({ received: true, delivered: result.delivered, route: result.route })
}

// ── Route factory ─────────────────────────────────────────────────────────────

export function webhookRoutes(ctx: WebhookContext): Router {
  const router = Router()

  // Use raw body parsing for HMAC verification
  router.use(express.raw({ type: 'application/json' }))

  // ── Generic plugin route (preferred) ──────────────────────────────────
  router.post('/:teamId/:pluginId', async (req: Request, res: Response) => {
    const teamId = p(req, 'teamId')
    const pluginId = p(req, 'pluginId')
    await handlePluginWebhook(ctx, teamId, pluginId, req, res)
  })

  // ── Legacy compat shims (DEPRECATED — removed in P9) ──────────────────
  //
  // The provider-named routes that pre-date P4 still get hit by
  // existing webhook configurations on the provider side. Forward
  // them through the generic handler with a fixed pluginId so the
  // tenant doesn't have to re-register the URL on day-one of the
  // upgrade. Each redirect emits a deprecation log line.

  const legacy = (provider: 'bitbucket' | 'github' | 'jira') =>
    async (req: Request, res: Response) => {
      const teamId = p(req, 'teamId')
      ctx.logger.warn(
        { teamId, provider },
        `Legacy /webhook/${provider}/:teamId route hit — please re-point provider to /webhook/${teamId}/${provider}`,
      )
      await handlePluginWebhook(ctx, teamId, provider, req, res)
    }

  router.post('/bitbucket/:teamId', legacy('bitbucket'))
  router.post('/github/:teamId', legacy('github'))
  router.post('/jira/:teamId', legacy('jira'))

  return router
}
