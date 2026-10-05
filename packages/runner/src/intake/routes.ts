import type { Express, Request, Response } from 'express'
import type { Logger } from 'pino'
import type { StateBackend } from '../state/backend'
import type { PluginRegistry } from '../plugins/registry'
import type { RunnerContext } from '../jobs/runner'
import { formatSseFrame } from '../runner/sse'
import { clampInvestigationListQuery } from '../state/investigation'
import { runIntakeStream } from './handler'
import { persistIntakeSnapshot, persistLiveIntakeSession } from './persist'
import {
  deleteIntakeSession,
  ensureIntakeWorkRoot,
  hydrateIntakeSession,
  intakeTurnActive,
  peekIntakeSession,
  updateIntakeToolAccess,
} from './session-store'
import {
  listPendingIntakePermissions,
  parseRule,
  readIntakePermissionConfig,
  resolveIntakePermission,
  resolveToolAccess,
} from './permissions'
import { listUserMcpServerCatalog } from '../jobs/runner'
import type { IntakeBuiltinCapability, IntakePermissionDecision, ToolAccessMode } from '@coro-ai/cloud-protocol'
import type { ExecutorSessionState } from '@coro-ai/plugin-sdk'
import type { InvestigationStatus } from '@coro-ai/cloud-protocol'

export function registerIntakeRoutes(
  app: Express,
  opts: {
    stateBackend: StateBackend
    logger: Logger
    plugins?: PluginRegistry
    runnerCtx?: RunnerContext
  },
): void {
  const { stateBackend, logger, plugins, runnerCtx } = opts

  app.post('/intake/stream', async (req: Request, res: Response) => {
    if (!plugins || !runnerCtx) {
      res.status(503).json({ error: 'Coro plan mode unavailable — runner plugins not initialized', reason: 'no-llm' })
      return
    }

    const body = req.body as {
      sessionId?: string
      message?: string
      transcript?: Array<{ role: 'user' | 'assistant'; content: string }>
      messages?: Array<{ role: 'user' | 'assistant'; content: string }>
      model?: string
      provider?: string
      context?: {
        recentRepos?: string[]
        recentReviewers?: string[]
        availableWorkflows?: Array<{ id: string; name: string; workflowPath: string; description: string }>
        userLocale?: string
      }
    }

    if (typeof body?.sessionId !== 'string' || !body.sessionId.trim()) {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }

    // The conversation lives in the runner's session store, so the dashboard
    // posts only `message`. It also sends `transcript` — its own copy of the
    // prior turns — which seeds the session when the runner has none: a
    // restart mid-investigation would otherwise silently drop the history the
    // browser is still showing. Seeding is ignored once turns exist, so the
    // normal path never re-bills the conversation.
    const explicitMessage = typeof body.message === 'string' ? body.message.trim() : ''
    const legacyTranscript = Array.isArray(body.messages) ? body.messages : []
    let message = explicitMessage
    let seedMessages = Array.isArray(body.transcript) ? body.transcript : []
    if (!message) {
      const lastUserIndex = legacyTranscript.reduce(
        (found, m, i) => (m?.role === 'user' && m.content?.trim() ? i : found),
        -1,
      )
      if (lastUserIndex >= 0) {
        message = legacyTranscript[lastUserIndex]!.content.trim()
        seedMessages = legacyTranscript.slice(0, lastUserIndex)
      }
    }

    if (!message) {
      res.status(400).json({ error: 'message is required' })
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    // We intentionally do NOT tie the LLM's abort signal to `req.close` /
    // `res.close`: under Express 4 + Node 20 the request emits 'close' as
    // soon as `express.json()` finishes draining the POST body, which would
    // cancel every LLM call a few ms after it starts. A refresh therefore
    // leaves the turn running. Writes into a closed socket are ignored so
    // that disconnect cannot abandon the generator before the turn is recorded.
    const abortController = new AbortController()
    logger.debug({ url: req.originalUrl }, 'intake stream: request received')

    const writeFrame = (payload: string) => {
      if (res.writableEnded || res.destroyed) return
      try {
        res.write(formatSseFrame(payload, 'message'))
      } catch {
        // The browser is gone. Keep consuming so the turn still records.
      }
    }

    try {
      for await (const event of runIntakeStream({
        sessionId: body.sessionId.trim(),
        message,
        ...(seedMessages.length > 0 ? { seedMessages } : {}),
        ...(typeof body.model === 'string' && body.model.trim()
          ? { model: body.model.trim(), provider: typeof body.provider === 'string' ? body.provider.trim() : undefined }
          : {}),
        context: {
          recentRepos: body.context?.recentRepos ?? [],
          recentReviewers: body.context?.recentReviewers ?? [],
          availableWorkflows: body.context?.availableWorkflows ?? [],
          userLocale: body.context?.userLocale,
        },
        registry: plugins,
        settings: runnerCtx.settings,
        signal: abortController.signal,
        logger,
        stateBackend,
      })) {
        if (event.type === 'token') {
          writeFrame(JSON.stringify({ type: 'token', text: event.text }))
        } else if (event.type === 'thinking') {
          writeFrame(JSON.stringify({ type: 'thinking', text: event.text }))
        } else if (event.type === 'tool_start') {
          writeFrame(JSON.stringify({
            type: 'tool_start',
            name: event.name,
            input: event.input,
            ...(event.subagent ? { subagent: event.subagent } : {}),
          }))
        } else if (event.type === 'tool_end') {
          writeFrame(JSON.stringify({
            type: 'tool_end',
            name: event.name,
            durationMs: event.durationMs,
            ok: event.ok,
            summary: event.summary,
            ...(event.error ? { error: event.error } : {}),
            ...(event.subagent ? { subagent: event.subagent } : {}),
          }))
        } else if (event.type === 'done') {
          writeFrame(JSON.stringify({
            type: 'done',
            usage: event.usage,
            ...(event.contextTokens != null ? { contextTokens: event.contextTokens } : {}),
            ...(event.sessionTokens != null ? { sessionTokens: event.sessionTokens } : {}),
            ...(event.turns != null ? { turns: event.turns } : {}),
          }))
        } else if (event.type === 'permission_request') {
          writeFrame(JSON.stringify({ type: 'permission_request', request: event.request }))
        } else if (event.type === 'permission_resolved') {
          writeFrame(JSON.stringify({
            type: 'permission_resolved',
            requestId: event.requestId,
            decision: event.decision,
            by: event.by,
          }))
        } else if (event.type === 'error') {
          const payload: Record<string, unknown> = { type: 'error', message: event.message }
          if (event.reason) payload['reason'] = event.reason
          writeFrame(JSON.stringify(payload))
        }
      }
      if (!res.writableEnded && !res.destroyed) {
        try {
          res.write(formatSseFrame(JSON.stringify({ type: 'done' }), 'done'))
        } catch {
          // Client already left.
        }
      }
    } catch (err) {
      logger.error({ err }, 'POST /intake/stream failed')
      writeFrame(JSON.stringify({ type: 'error', message: (err as Error).message }))
    } finally {
      if (!res.writableEnded) res.end()
    }
  })

  app.get('/intake/sessions', async (req: Request, res: Response) => {
    const query = clampInvestigationListQuery({
      limit: Number(req.query['limit']),
      offset: Number(req.query['offset']),
    })
    try {
      const result = await stateBackend.listInvestigations(query)
      res.json(result)
    } catch (err) {
      logger.error({ err }, 'GET /intake/sessions failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.get('/intake/sessions/:sessionId', async (req: Request, res: Response) => {
    const sessionId = String(req.params['sessionId'] ?? '').trim()
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }
    try {
      const record = await stateBackend.getInvestigation(sessionId)
      if (!record) {
        res.status(404).json({ error: 'Investigation not found' })
        return
      }
      hydrateIntakeSession({
        id: record.id,
        turns: record.turns,
        tokens: record.tokens,
        contextTokens: record.contextUsed,
        ...(record.executorSession
          ? { executorSession: record.executorSession as ExecutorSessionState }
          : {}),
        ...(record.executorId ? { executorId: record.executorId } : {}),
        ...(record.toolAccess ? { toolAccess: record.toolAccess } : {}),
      })
      ensureIntakeWorkRoot(record.id)
      const live = peekIntakeSession(record.id)
      res.json({
        ...record,
        streaming: intakeTurnActive(record.id),
        toolAccess: live?.toolAccess ?? record.toolAccess ?? null,
        pendingPermissions: listPendingIntakePermissions(record.id),
      })
    } catch (err) {
      logger.error({ err, sessionId }, 'GET /intake/sessions/:id failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/intake/sessions/:sessionId/permissions/:requestId', (req: Request, res: Response) => {
    const sessionId = String(req.params['sessionId'] ?? '').trim()
    const requestId = String(req.params['requestId'] ?? '').trim()
    if (!sessionId || !requestId) {
      res.status(400).json({ error: 'sessionId and requestId are required' })
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const decision = body['decision']
    if (!isPermissionDecision(decision)) {
      res.status(400).json({ error: 'decision must be once, conversation, always, or deny' })
      return
    }
    const mode = body['mode']
    if (mode !== undefined && mode !== 'ask' && mode !== 'allow') {
      res.status(400).json({ error: 'mode must be ask or allow' })
      return
    }
    const message = typeof body['message'] === 'string' ? body['message'].slice(0, 1000) : undefined
    const rule = typeof body['rule'] === 'string' ? body['rule'] : undefined
    const result = resolveIntakePermission(sessionId, requestId, {
      decision,
      ...(rule ? { rule } : {}),
      ...(mode === 'ask' || mode === 'allow' ? { mode } : {}),
      ...(message ? { message } : {}),
    })
    if (!result.ok) {
      res.status(result.status).json({ error: result.error })
      return
    }
    res.json({ resolved: true })
  })

  app.get('/intake/sessions/:sessionId/tool-access', (req: Request, res: Response) => {
    const sessionId = String(req.params['sessionId'] ?? '').trim()
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }
    res.json(toolAccessPayload(sessionId, logger))
  })

  app.put('/intake/sessions/:sessionId/tool-access', async (req: Request, res: Response) => {
    const sessionId = String(req.params['sessionId'] ?? '').trim()
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const capabilities = body['capabilities']
    const mcp = body['mcp']
    const allow = body['allow']
    const deny = body['deny']
    if (allow !== undefined && !isRuleList(allow)) {
      res.status(400).json({ error: 'allow must be an array of permission rules' })
      return
    }
    if (deny !== undefined && !isRuleList(deny)) {
      res.status(400).json({ error: 'deny must be an array of permission rules' })
      return
    }
    if (capabilities !== undefined && !isModePatch(capabilities, ['files', 'filesWrite', 'shell', 'web'])) {
      res.status(400).json({ error: 'capabilities must map files, filesWrite, shell, or web to off, ask, allow, or null' })
      return
    }
    if (mcp !== undefined && !isModeRecord(mcp)) {
      res.status(400).json({ error: 'mcp must map server ids to off, ask, allow, or null' })
      return
    }
    updateIntakeToolAccess(sessionId, access => {
      if (capabilities && typeof capabilities === 'object') {
        for (const [key, value] of Object.entries(capabilities as Record<string, unknown>)) {
          if (value === null) delete access.capabilities[key as IntakeBuiltinCapability]
          else access.capabilities[key as IntakeBuiltinCapability] = value as ToolAccessMode
        }
      }
      if (mcp && typeof mcp === 'object') {
        for (const [key, value] of Object.entries(mcp as Record<string, unknown>)) {
          if (value === null) delete access.mcp[key]
          else access.mcp[key] = value as ToolAccessMode
        }
      }
      if (Array.isArray(allow)) access.allow = allow as string[]
      if (Array.isArray(deny)) access.deny = deny as string[]
    })
    try {
      await persistLiveIntakeSession(stateBackend, sessionId)
    } catch (err) {
      logger.warn({ err, sessionId }, 'intake: failed to persist tool access')
    }
    res.json(toolAccessPayload(sessionId, logger))
  })

  app.put('/intake/sessions/:sessionId', async (req: Request, res: Response) => {
    const sessionId = String(req.params['sessionId'] ?? '').trim()
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const status = body['status']
    if (status !== undefined && status !== 'active' && status !== 'dispatched' && status !== 'closed') {
      res.status(400).json({ error: 'status must be active, dispatched, or closed' })
      return
    }
    try {
      const result = await persistIntakeSnapshot(stateBackend, sessionId, {
        ...(Array.isArray(body['items']) ? { items: body['items'] } : {}),
        ...(body['readiness'] !== undefined ? { readiness: body['readiness'] as IntakeSnapshotReadiness } : {}),
        ...(body['findings'] === null || typeof body['findings'] === 'string'
          ? { findings: body['findings'] as string | null }
          : {}),
        ...(isModelChoice(body['modelChoice']) ? { modelChoice: body['modelChoice'] } : {}),
        ...(typeof body['turnCount'] === 'number' ? { turnCount: body['turnCount'] } : {}),
        ...(typeof body['tokens'] === 'number' ? { tokens: body['tokens'] } : {}),
        ...(typeof body['contextUsed'] === 'number' ? { contextUsed: body['contextUsed'] } : {}),
        ...(typeof body['title'] === 'string' ? { title: body['title'] } : {}),
        ...(status ? { status: status as InvestigationStatus } : {}),
        ...(body['dispatchedJobId'] === null || typeof body['dispatchedJobId'] === 'string'
          ? { dispatchedJobId: body['dispatchedJobId'] as string | null }
          : {}),
      })
      res.json(result)
    } catch (err) {
      logger.error({ err, sessionId }, 'PUT /intake/sessions/:id failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  /**
   * Drops both the in-memory cache and the durable row. New conversation
   * and dispatch no longer call this — history stays. Kept for explicit discard.
   */
  app.delete('/intake/sessions/:sessionId', async (req: Request, res: Response) => {
    const sessionId = String(req.params['sessionId'] ?? '').trim()
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' })
      return
    }
    const memoryDeleted = deleteIntakeSession(sessionId)
    try {
      await stateBackend.deleteInvestigation(sessionId)
      res.json({ deleted: true, memoryDeleted })
    } catch (err) {
      logger.error({ err, sessionId }, 'DELETE /intake/sessions/:id failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })
}

type IntakeSnapshotReadiness = {
  state: 'investigating' | 'ready' | 'no-run-needed'
  openQuestions: string[]
  note: string
} | null

const PERMISSION_DECISIONS = new Set(['once', 'conversation', 'always', 'deny'])
const TOOL_ACCESS_MODES = new Set(['off', 'ask', 'allow'])

function isPermissionDecision(value: unknown): value is IntakePermissionDecision {
  return typeof value === 'string' && PERMISSION_DECISIONS.has(value)
}

function isRuleList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && parseRule(item) !== null)
}

function isModePatch(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.entries(value as Record<string, unknown>).every(([key, mode]) =>
    keys.includes(key) && (mode === null || (typeof mode === 'string' && TOOL_ACCESS_MODES.has(mode))),
  )
}

function isModeRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every(mode =>
    mode === null || (typeof mode === 'string' && TOOL_ACCESS_MODES.has(mode)),
  )
}

function toolAccessPayload(sessionId: string, log: Logger) {
  const session = peekIntakeSession(sessionId)
  const catalog = listUserMcpServerCatalog({ logger: log })
  const cfg = readIntakePermissionConfig(log)
  return {
    toolAccess: session?.toolAccess ?? null,
    resolved: resolveToolAccess(session?.toolAccess, cfg, catalog),
    catalog: { mcpServers: catalog },
    globalAllow: cfg.allow,
  }
}

function isModelChoice(value: unknown): value is { provider: string; model: string } {
  if (!value || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  return typeof rec['provider'] === 'string' && typeof rec['model'] === 'string'
}
