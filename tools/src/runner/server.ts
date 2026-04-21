// ── Runner Local HTTP Server ──────────────────────────────────────────────────
//
// A lightweight Express server that runs on the developer's machine when the
// runner is in hybrid mode. This provides a REST API for CLI commands to
// dispatch jobs, check status, and stream logs — same interface as the legacy
// monolith but backed by the cloud StateBackend.

import express, { Request, Response } from 'express'
import http from 'http'
import path from 'path'
import { spawn } from 'child_process'
import { Logger } from 'pino'
import type { Dispatcher } from '../jobs/dispatcher'
import type { StateBackend } from '../state/backend'
import {
  loadLocalConfig,
  saveLocalConfig,
  defaultConfigPath,
  detectMode,
  resolveIntelligenceDir,
  resolveWorkingDir as resolveLocalWorkingDir,
} from '../config/local-config'
import { resolveClaudeCodeCliPath, ensureClaudeCodeCliExecutable } from '../claude-code-path'

export interface RunnerServerOptions {
  port: number
  dispatcher: Dispatcher
  stateBackend: StateBackend
  logger: Logger
  mode?: 'hybrid' | 'local'
}

/** Mask a secret for display: show enough prefix/suffix to recognise it, hide the middle. */
function redactSecret(value: string | undefined | null): string {
  if (!value) return ''
  if (value.length <= 16) return `${value.slice(0, 2)}...${value.slice(-2)}`
  return `${value.slice(0, 12)}...${value.slice(-4)}`
}

/** The dashboard echoes redacted values back on submit; treat `...` as "unchanged". */
function isRedacted(value: unknown): boolean {
  return typeof value === 'string' && value.includes('...')
}

/**
 * Parse the stdout of `claude setup-token` and return the OAuth token, if any.
 * The CLI may print instructional text around the token; we prefer lines
 * starting with the known token prefix and fall back to the last non-empty line.
 */
function extractOauthToken(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const tokenLike = lines.reverse().find(l => /^sk-ant-[A-Za-z0-9_-]+/.test(l))
  if (tokenLike) {
    // In case the CLI appends punctuation or extra words after the token.
    const match = tokenLike.match(/^(sk-ant-[A-Za-z0-9_-]+)/)
    if (match) return match[1]
  }
  const last = lines[0]  // reversed above, so [0] is the real last line
  return last && last.length >= 16 ? last : null
}

/**
 * Pull the first Anthropic OAuth URL out of CLI output (stdout or stderr).
 * We return it to the dashboard so the user can click through if the CLI
 * failed to open a browser automatically (common on headless machines or
 * when the runner was started from a GUI/service launcher with no $BROWSER).
 */
function extractOauthUrl(text: string): string | null {
  const match = text.match(/https:\/\/(?:[\w.-]*\.)?anthropic\.com\/[^\s"')<>]+/i)
  return match ? match[0] : null
}

/**
 * Create and start the runner's local HTTP server.
 * CLI commands (`a5 migrate`, `a5 status`, etc.) talk to this.
 */
export function createRunnerServer(opts: RunnerServerOptions): http.Server {
  const { port, dispatcher, stateBackend, logger, mode = 'hybrid' } = opts
  const app = express()
  app.use(express.json())

  // ── Health ──────────────────────────────────────────────────────────────

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', mode, version: '0.1.0' })
  })

  // ── Job dispatch ────────────────────────────────────────────────────────

  app.post('/jobs/migrate', async (req: Request, res: Response) => {
    try {
      const { repo, projects, reviewers, stagingUrl, serviceName } = req.body ?? {}
      if (!repo) { res.status(400).json({ error: 'repo is required' }); return }

      const job = await dispatcher.dispatch({
        type: 'migration',
        params: { repo, projects, reviewers, stagingUrl, serviceName },
      })
      res.status(201).json({
        jobId: job.id,
        type: job.type,
        status: job.status,
        streamUrl: `/jobs/${job.id}/stream`,
      })
    } catch (err) {
      logger.error({ err }, 'Migration dispatch failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/jobs/feature', async (req: Request, res: Response) => {
    try {
      const { repo, description, reviewers, jiraTicket } = req.body ?? {}
      if (!repo) { res.status(400).json({ error: 'repo is required' }); return }

      const job = await dispatcher.dispatch({
        type: 'feature',
        params: { repo, description, reviewers, jiraTicket },
      })
      res.status(201).json({
        jobId: job.id,
        type: job.type,
        status: job.status,
        streamUrl: `/jobs/${job.id}/stream`,
      })
    } catch (err) {
      logger.error({ err }, 'Feature dispatch failed')
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ── Job CRUD ────────────────────────────────────────────────────────────

  app.get('/jobs', async (_req: Request, res: Response) => {
    try {
      const jobs = await stateBackend.listJobs()
      res.json(jobs)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.get('/jobs/:jobId', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const job = await stateBackend.getJob(jobId)
      if (!job) { res.status(404).json({ error: 'Job not found' }); return }
      res.json(job)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ── Log streaming (SSE) ─────────────────────────────────────────────────

  app.get('/jobs/:jobId/stream', async (req: Request, res: Response) => {
    const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
    const job = await stateBackend.getJob(jobId)

    if (!job) {
      res.status(404).json({ error: 'Job not found' })
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    // Send existing logs first
    const existingLogs = await stateBackend.getLog(jobId)
    for (const line of existingLogs) {
      res.write(`data: ${line}\n\n`)
    }

    // Poll for new logs (simple polling — could be improved with pub/sub)
    let lastLen = existingLogs.length
    const interval = setInterval(async () => {
      try {
        const currentLen = await stateBackend.logLength(jobId)
        if (currentLen > lastLen) {
          const newLines = await stateBackend.getLog(jobId, lastLen)
          for (const line of newLines) {
            res.write(`data: ${line}\n\n`)
          }
          lastLen = currentLen
        }

        // Check if job is done
        const currentJob = await stateBackend.getJob(jobId)
        if (currentJob && (currentJob.status === 'complete' || currentJob.status === 'failed')) {
          res.write(`event: done\ndata: ${currentJob.status}\n\n`)
          clearInterval(interval)
          res.end()
        }
      } catch {
        // Ignore poll errors
      }
    }, 1000)

    req.on('close', () => {
      clearInterval(interval)
    })
  })

  // ── Resume ──────────────────────────────────────────────────────────────

  app.post('/jobs/:jobId/resume', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const { fromPhase, clearSession } = req.body ?? {}
      await dispatcher.resumeJob(jobId, fromPhase, clearSession)
      res.json({ resumed: jobId })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // ── Message injection ───────────────────────────────────────────────────

  app.post('/jobs/:jobId/message', async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
      const { message } = req.body ?? {}
      if (!message) { res.status(400).json({ error: 'message is required' }); return }
      await dispatcher.sendMessage(jobId, message)
      res.json({ sent: true })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  // ── Configuration ────────────────────────────────────────────────────────

  app.get('/config', (_req: Request, res: Response) => {
    try {
      const config = loadLocalConfig()
      const configPath = defaultConfigPath()
      const detected = detectMode(config)

      // Redact sensitive fields for display. Both apiKey and oauthToken need
      // masking; we always send back the full `method` tag so the UI renders
      // the correct field regardless of which one currently has a value.
      const safeConfig = config ? {
        ...config,
        anthropic: {
          method: config.anthropic?.method ?? 'apiKey',
          apiKey: redactSecret(config.anthropic?.apiKey),
          oauthToken: redactSecret(config.anthropic?.oauthToken),
        },
        git: config.git ? {
          ...config.git,
          token: config.git.token
            ? `${config.git.token.slice(0, 6)}...${config.git.token.slice(-4)}`
            : '',
        } : undefined,
      } : null

      res.json({
        config: safeConfig,
        configPath,
        mode: detected,
        resolved: config ? {
          intelligenceDir: resolveIntelligenceDir(config),
          workingDir: resolveLocalWorkingDir(config),
        } : null,
      })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.put('/config', (req: Request, res: Response) => {
    try {
      const updates = req.body
      if (!updates || typeof updates !== 'object') {
        res.status(400).json({ error: 'Request body must be a config object' })
        return
      }

      // Load existing, merge, save. The placeholder apiKey keeps zod's refine
      // happy when no real credential has been written yet; real writes below
      // overwrite it before save.
      const existing = loadLocalConfig() ?? { anthropic: { method: 'apiKey' as const, apiKey: '' } }
      const merged = { ...existing }

      // Update anthropic auth. The UI sends a discriminated object with
      // `method` plus whichever field belongs to that method. We never trust
      // a redacted value ("...") — if the user hasn't changed the secret,
      // keep whatever is already on disk. When the method flips we wipe the
      // other credential so the config doesn't accumulate stale secrets.
      if (updates.anthropic) {
        const incomingMethod: 'apiKey' | 'oauth' =
          updates.anthropic.method === 'oauth' ? 'oauth' : 'apiKey'

        if (incomingMethod === 'apiKey') {
          const nextKey = isRedacted(updates.anthropic.apiKey)
            ? existing.anthropic?.apiKey ?? ''
            : updates.anthropic.apiKey ?? existing.anthropic?.apiKey ?? ''
          merged.anthropic = { method: 'apiKey', apiKey: nextKey }
        } else {
          const nextToken = isRedacted(updates.anthropic.oauthToken)
            ? existing.anthropic?.oauthToken ?? ''
            : updates.anthropic.oauthToken ?? existing.anthropic?.oauthToken ?? ''
          merged.anthropic = { method: 'oauth', oauthToken: nextToken }
        }
      }

      // Update intelligence
      if (updates.intelligence) {
        merged.intelligence = { ...existing.intelligence, ...updates.intelligence }
      }

      // Update paths
      if (updates.paths) {
        merged.paths = { ...existing.paths, ...updates.paths }
      }

      // Update git
      if (updates.git) {
        merged.git = {
          ...existing.git,
          ...updates.git,
          // Don't overwrite token with redacted value
          token: updates.git.token?.includes('...') ? existing.git?.token ?? '' : updates.git.token ?? existing.git?.token ?? '',
        }
      }

      // Respect local mode — strip cloud if not explicitly set
      if (!updates.cloud) {
        delete (merged as Record<string, unknown>).cloud
      }

      saveLocalConfig(merged)
      logger.info('Configuration updated via dashboard')
      res.json({ saved: true, configPath: defaultConfigPath() })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // ── Generate Claude Code OAuth token ────────────────────────────────────
  //
  // Runs `claude setup-token` on the runner host. That command opens a
  // browser on the runner machine (which in local mode is the developer's
  // own laptop) and prints a long-lived token to stdout on success. We
  // prefer the Claude Code CLI that ships bundled with
  // `@anthropic-ai/claude-agent-sdk` (always present) so this works even
  // when the standalone `claude` binary isn't on PATH — which is common
  // when the runner is launched from a GUI/service launcher rather than
  // a login shell. If the bundled CLI can't be resolved for some reason
  // we fall back to spawning `claude` from PATH.
  //
  // Serialised via a simple in-flight flag so two dashboard tabs can't race.

  let setupTokenRunning = false

  app.post('/config/anthropic/generate-oauth-token', (_req: Request, res: Response) => {
    if (setupTokenRunning) {
      res.status(409).json({ error: 'IN_PROGRESS', message: 'Another token setup is already running' })
      return
    }
    setupTokenRunning = true

    // Resolve which CLI to spawn. Prefer the bundled one so we don't depend
    // on the user having a global `claude` on PATH.
    let cmd: string
    let args: string[]
    let usingBundled = false
    try {
      const cliPath = resolveClaudeCodeCliPath(process.cwd())
      ensureClaudeCodeCliExecutable(cliPath, logger)
      cmd = process.execPath // same node that's running the runner
      args = [cliPath, 'setup-token']
      usingBundled = true
    } catch (err) {
      logger.warn({ err }, 'Could not resolve bundled Claude Code CLI; falling back to `claude` on PATH')
      cmd = 'claude'
      args = ['setup-token']
    }

    let child
    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })
    } catch (err) {
      setupTokenRunning = false
      res.status(500).json({ error: 'SPAWN_FAILED', message: (err as Error).message })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    // Bound the wait so a hung browser flow doesn't leak the subprocess forever.
    const TIMEOUT_MS = 120_000
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      setupTokenRunning = false
      res.status(504).json({
        error: 'TIMEOUT',
        message: 'claude setup-token did not complete within 120s',
        authUrl: extractOauthUrl(stderr) ?? extractOauthUrl(stdout),
        stderr: stderr.trim().slice(0, 2000),
      })
    }, TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8') })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      setupTokenRunning = false
      if (err.code === 'ENOENT') {
        res.status(404).json({
          error: 'CLI_NOT_FOUND',
          message: usingBundled
            ? 'Could not spawn the bundled Claude Code CLI. Reinstall `@anthropic-ai/claude-agent-sdk` in the runner.'
            : 'The `claude` CLI is not on PATH. Install Claude Code and try again.',
        })
        return
      }
      res.status(500).json({ error: 'SPAWN_FAILED', message: err.message })
    })

    child.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      setupTokenRunning = false

      if (code !== 0) {
        res.status(500).json({
          error: 'SETUP_FAILED',
          exitCode: code,
          stderr: stderr.trim().slice(0, 2000),
          authUrl: extractOauthUrl(stderr) ?? extractOauthUrl(stdout),
        })
        return
      }

      // `claude setup-token` prints status/UX to stderr and the bare token
      // (often prefixed with `sk-ant-oat01-`) to stdout. We pick the last
      // non-empty line that looks like a token.
      const token = extractOauthToken(stdout)
      if (!token) {
        res.status(500).json({
          error: 'NO_TOKEN_IN_OUTPUT',
          stdout: stdout.trim().slice(0, 2000),
          stderr: stderr.trim().slice(0, 2000),
          authUrl: extractOauthUrl(stderr) ?? extractOauthUrl(stdout),
        })
        return
      }
      res.json({ token })
    })
  })

  // ── Dashboard (served under /dashboard/) ───────────────────────────────

  const dashboardDir = path.join(__dirname, '../../dashboard/dist')
  app.use('/dashboard', express.static(dashboardDir))
  app.get('/dashboard/*', (_req: Request, res: Response) => {
    res.sendFile(path.join(dashboardDir, 'index.html'), err => {
      if (err) res.status(404).json({ error: 'Not found' })
    })
  })

  // Redirect root to dashboard for convenience
  app.get('/', (_req: Request, res: Response) => {
    res.redirect('/dashboard/')
  })

  // ── Start server ────────────────────────────────────────────────────────

  const server = http.createServer(app)
  server.listen(port, () => {
    logger.info({ port }, 'Runner HTTP server listening')
  })

  return server
}
