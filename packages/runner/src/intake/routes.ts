import type { Express, Request, Response } from 'express'
import type { Logger } from 'pino'
import type { StateBackend } from '../state/backend'
import type { PluginRegistry } from '../plugins/registry'
import type { RunnerContext } from '../jobs/runner'
import { formatSseFrame } from '../runner/sse'
import { clampInvestigationListQuery } from '../state/investigation'
import { runIntakeStream } from './handler'
import { persistIntakeSnapshot } from './persist'
import {
  deleteIntakeSession,
  ensureIntakeWorkRoot,
  hydrateIntakeSession,
} from './session-store'
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

    // Plan-mode requests are short (a single LLM round-trip, typically
    // under 10s). We intentionally do NOT tie the LLM's abort signal
    // to `req.close` / `res.close`: under Express 4 + Node 20 the
    // request emits 'close' as soon as `express.json()` finishes
    // draining the POST body, which would cancel every LLM call a few
    // ms after it starts. If the browser disconnects mid-flight we'll
    // simply write SSE bytes into a closed socket — harmless. Longer-
    // running stream surfaces should bring their own cancellation
    // protocol rather than borrow the HTTP request lifecycle.
    const abortController = new AbortController()
    logger.debug({ url: req.originalUrl }, 'intake stream: request received')

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
          res.write(formatSseFrame(JSON.stringify({ type: 'token', text: event.text }), 'message'))
        } else if (event.type === 'thinking') {
          res.write(formatSseFrame(JSON.stringify({ type: 'thinking', text: event.text }), 'message'))
        } else if (event.type === 'tool_start') {
          res.write(formatSseFrame(JSON.stringify({
            type: 'tool_start',
            name: event.name,
            input: event.input,
          }), 'message'))
        } else if (event.type === 'tool_end') {
          res.write(formatSseFrame(JSON.stringify({
            type: 'tool_end',
            name: event.name,
            durationMs: event.durationMs,
            ok: event.ok,
            summary: event.summary,
            ...(event.error ? { error: event.error } : {}),
          }), 'message'))
        } else if (event.type === 'done') {
          res.write(formatSseFrame(JSON.stringify({
            type: 'done',
            usage: event.usage,
            ...(event.contextTokens != null ? { contextTokens: event.contextTokens } : {}),
            ...(event.sessionTokens != null ? { sessionTokens: event.sessionTokens } : {}),
            ...(event.turns != null ? { turns: event.turns } : {}),
          }), 'message'))
        } else if (event.type === 'error') {
          const payload: Record<string, unknown> = { type: 'error', message: event.message }
          if ((event as { reason?: string }).reason) payload['reason'] = (event as { reason?: string }).reason
          res.write(formatSseFrame(JSON.stringify(payload), 'message'))
        }
      }
      res.write(formatSseFrame(JSON.stringify({ type: 'done' }), 'done'))
    } catch (err) {
      logger.error({ err }, 'POST /intake/stream failed')
      res.write(formatSseFrame(JSON.stringify({ type: 'error', message: (err as Error).message }), 'message'))
    } finally {
      res.end()
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
      })
      ensureIntakeWorkRoot(record.id)
      res.json(record)
    } catch (err) {
      logger.error({ err, sessionId }, 'GET /intake/sessions/:id failed')
      res.status(500).json({ error: (err as Error).message })
    }
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

function isModelChoice(value: unknown): value is { provider: string; model: string } {
  if (!value || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  return typeof rec['provider'] === 'string' && typeof rec['model'] === 'string'
}
