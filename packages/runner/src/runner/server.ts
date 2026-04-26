// ── Runner Local HTTP Server ──────────────────────────────────────────────────
//
// A lightweight Express server that runs on the developer's machine. It serves
// the dashboard at `/dashboard/` and exposes a REST API for CLI commands and
// the dashboard to dispatch jobs, check status, stream logs, and edit
// configuration. State is backed by either the cloud (hybrid mode) or local
// SQLite (local mode) — the server is identical in both cases.

import express, { Request, Response } from 'express'
import http from 'http'
import path from 'path'
import fs from 'fs'
import { spawn, spawnSync } from 'child_process'
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
import { createJobInput, type CreateJobRequest } from '../jobs/creation'
import { resolveDashboardDist } from '../dashboard-dist'
import { ClaudeLoginManager } from './claude-login'

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
 * Shell-quote a string for safe inclusion inside a POSIX `sh -c` command.
 * Wraps in single quotes and escapes any single quotes via the classic
 * `'\''` dance. Used when we build a command string for `script`'s PTY
 * shim since that tool takes a single shell string rather than argv.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Strip ANSI colour/escape sequences from captured terminal output. `claude
 * setup-token` uses Ink (React-for-terminals) which wraps values in ANSI
 * colour codes, so a naive line-start match for `sk-ant-…` will miss the
 * real token.
 */
function stripAnsi(s: string): string {
  // Matches standard CSI sequences and OSC sequences used by Ink.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1B\][^\x07]*\x07/g, '')
}

/**
 * Pull an Anthropic OAuth token out of combined CLI output.
 *
 * The CLI uses Ink (React-for-terminals) which wraps the token in ANSI
 * colour codes and — critically — hard-wraps text at the current terminal
 * width. We set `COLUMNS=10000` in the spawn env to keep the token on a
 * single line; if that's honoured, a simple anywhere-match picks it up.
 *
 * We return the *longest* match so that if Ink re-rendered the frame
 * multiple times we still prefer the fully-printed value over any
 * in-progress render.
 */
function extractOauthToken(rawOutput: string): string | null {
  const text = stripAnsi(rawOutput)

  // Require a long token body (>= 80 chars after the prefix). Real tokens
  // are ~100+ chars; an 80-col-wrapped token would yield at most ~67 body
  // chars, so this threshold rejects truncated captures that would 401.
  const oatMatches = text.match(/sk-ant-oat\d+-[A-Za-z0-9_-]{80,}/g)
  if (oatMatches && oatMatches.length) {
    return oatMatches.reduce((a, b) => (b.length > a.length ? b : a))
  }

  const anyMatches = text.match(/sk-ant-[A-Za-z0-9_-]{80,}/g)
  if (anyMatches && anyMatches.length) {
    return anyMatches.reduce((a, b) => (b.length > a.length ? b : a))
  }

  return null
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
 * Detect whether `claude setup-token --help` supports scope flags.
 * Newer CLIs expose `--scope` or `--scopes`; older CLIs do not.
 */
function detectSetupTokenScopeFlag(cliCmd: string, cliArgs: string[], logger: Logger): '--scope' | '--scopes' | null {
  try {
    const help = spawnSync(cliCmd, [...cliArgs, '--help'], {
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      encoding: 'utf-8',
      timeout: 5_000,
    })
    const text = `${help.stdout ?? ''}\n${help.stderr ?? ''}`
    if (/\b--scope\b/.test(text)) return '--scope'
    if (/\b--scopes\b/.test(text)) return '--scopes'
    return null
  } catch (err) {
    logger.warn({ err }, 'Could not probe setup-token --help; using legacy invocation')
    return null
  }
}

/**
 * Detect whether setup-token supports an explicit re-auth/force-refresh flag.
 * If present, we should use it so the CLI does not hand back a cached token
 * that may have narrower scopes than we now require.
 */
function detectSetupTokenForceFlag(cliCmd: string, cliArgs: string[], logger: Logger): string | null {
  try {
    const help = spawnSync(cliCmd, [...cliArgs, '--help'], {
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      encoding: 'utf-8',
      timeout: 5_000,
    })
    const text = `${help.stdout ?? ''}\n${help.stderr ?? ''}`
    const candidates = ['--force', '--reauth', '--re-auth', '--reset-auth'] as const
    for (const flag of candidates) {
      if (new RegExp(`\\b${flag.replace(/[-]/g, '\\-')}\\b`).test(text)) {
        return flag
      }
    }
    return null
  } catch (err) {
    logger.warn({ err }, 'Could not probe setup-token force flags; using default invocation')
    return null
  }
}

/** Best-effort MIME type inference for the artefact-content endpoint. */
function mimeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.md':   return 'text/markdown; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.txt':  return 'text/plain; charset=utf-8'
    case '.html': return 'text/html; charset=utf-8'
    case '.yml':
    case '.yaml': return 'text/yaml; charset=utf-8'
    default:      return 'text/plain; charset=utf-8'
  }
}

/**
 * Create and start the runner's local HTTP server.
 * CLI commands (`coro job`, `coro status`, etc.) talk to this.
 */
export function createRunnerServer(opts: RunnerServerOptions): http.Server {
  const { port, dispatcher, stateBackend, logger, mode = 'hybrid' } = opts
  const app = express()
  app.use(express.json())
  const claudeLoginManager = new ClaudeLoginManager({ logger })

  function saveClaudeLoginConfig(account?: {
    email?: string
    organization?: string
    subscriptionType?: string
    tokenSource?: string
    apiKeySource?: string
    apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'mantle'
  }) {
    const existing = loadLocalConfig() ?? { anthropic: { method: 'apiKey' as const, apiKey: '' } }
    saveLocalConfig({
      ...existing,
      anthropic: {
        method: 'claudeLogin',
        account,
      },
    })
  }

  // ── Health ──────────────────────────────────────────────────────────────

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', mode, version: '0.1.0' })
  })

  // ── Job dispatch ────────────────────────────────────────────────────────

  app.post('/jobs', async (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<CreateJobRequest>
      if (typeof body?.workflowPath !== 'string' || !body.workflowPath.trim()) {
        res.status(400).json({ error: 'workflowPath is required' })
        return
      }

      const input = createJobInput(body as CreateJobRequest)
      const job = await dispatcher.dispatch(input)
      res.status(201).json({
        jobId: job.id,
        type: job.type,
        status: job.status,
        streamUrl: `/jobs/${job.id}/stream`,
      })
    } catch (err) {
      logger.error({ err }, 'Generic job dispatch failed')
      res.status(400).json({ error: (err as Error).message })
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

  // ── Artefact content ────────────────────────────────────────────────────
  // Read-only endpoint that returns the text content of an artefact whose
  // `data.path` points at a file inside the job's working directory. Used by
  // the dashboard to render `plan-md`, `report-md`, `implementation-plan-md`,
  // `analysis-contract`, etc. in a modal.
  //
  // Security: the resolved path MUST stay inside `{workingDir}/{jobId}/`.

  app.get('/jobs/:jobId/artifacts/:artifactId/content', async (req: Request, res: Response) => {
    const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId
    const artifactId = Array.isArray(req.params.artifactId) ? req.params.artifactId[0] : req.params.artifactId

    try {
      const job = await stateBackend.getJob(jobId)
      if (!job) {
        res.status(404).json({ error: `Job not found: ${jobId}` })
        return
      }

      const artifact = (job.artifacts ?? []).find(a => a.id === artifactId)
      if (!artifact) {
        res.status(404).json({ error: `Artifact not found: ${artifactId}` })
        return
      }

      const rawPath = (artifact.data as Record<string, unknown> | undefined)?.['path']
      if (typeof rawPath !== 'string' || !rawPath.trim()) {
        res.status(400).json({ error: 'Artifact has no `data.path` to read' })
        return
      }

      const config = loadLocalConfig()
      const workingDir = resolveLocalWorkingDir(config)
      const jobWorkingDir = path.resolve(workingDir, jobId)
      const resolved = path.resolve(jobWorkingDir, rawPath)

      if (!resolved.startsWith(jobWorkingDir + path.sep) && resolved !== jobWorkingDir) {
        logger.warn({ jobId, artifactId, rawPath, resolved }, 'Artifact path escape attempt blocked')
        res.status(400).json({ error: 'Artifact path is outside the job working directory' })
        return
      }

      const content = await fs.promises.readFile(resolved, 'utf-8')
      res.setHeader('Content-Type', mimeForPath(resolved))
      res.send(content)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      res.status(404).json({ error: `Could not read artifact content: ${msg}` })
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
      // masking; claudeLogin stores only metadata, so that can be returned as-is.
      // We always send back the full `method` tag so the UI renders the correct
      // auth state regardless of which credential is currently active.
      const safeConfig = config ? {
        ...config,
        anthropic: {
          method: config.anthropic?.method ?? 'apiKey',
          apiKey: redactSecret(config.anthropic?.apiKey),
          oauthToken: redactSecret(config.anthropic?.oauthToken),
          account: config.anthropic?.account,
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
        const incomingMethod: 'apiKey' | 'oauth' | 'claudeLogin' =
          updates.anthropic.method === 'oauth'
            ? 'oauth'
            : updates.anthropic.method === 'claudeLogin'
              ? 'claudeLogin'
              : 'apiKey'

        if (incomingMethod === 'apiKey') {
          const nextKey = isRedacted(updates.anthropic.apiKey)
            ? existing.anthropic?.apiKey ?? ''
            : updates.anthropic.apiKey ?? existing.anthropic?.apiKey ?? ''
          merged.anthropic = { method: 'apiKey', apiKey: nextKey }
        } else if (incomingMethod === 'oauth') {
          const nextToken = isRedacted(updates.anthropic.oauthToken)
            ? existing.anthropic?.oauthToken ?? ''
            : updates.anthropic.oauthToken ?? existing.anthropic?.oauthToken ?? ''
          merged.anthropic = { method: 'oauth', oauthToken: nextToken }
        } else {
          merged.anthropic = {
            method: 'claudeLogin',
            account:
              updates.anthropic.account && typeof updates.anthropic.account === 'object'
                ? updates.anthropic.account
                : existing.anthropic?.account,
          }
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

  app.get('/config/anthropic/claude-login/status', (_req: Request, res: Response) => {
    try {
      const state = claudeLoginManager.getState()
      if (state.status === 'connected') {
        saveClaudeLoginConfig(state.account)
      }
      res.json(state)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/config/anthropic/claude-login/start', async (_req: Request, res: Response) => {
    try {
      const state = await claudeLoginManager.start()
      if (state.status === 'connected') {
        saveClaudeLoginConfig(state.account)
      }
      res.json(state)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  app.post('/config/anthropic/claude-login/callback', async (req: Request, res: Response) => {
    try {
      const authorizationCode = typeof req.body?.authorizationCode === 'string'
        ? req.body.authorizationCode.trim()
        : ''
      const callbackState = typeof req.body?.state === 'string'
        ? req.body.state
        : undefined

      if (!authorizationCode) {
        res.status(400).json({ error: 'authorizationCode is required' })
        return
      }

      const state = await claudeLoginManager.submitCallback({
        authorizationCode,
        state: callbackState,
      })
      if (state.status === 'connected') {
        saveClaudeLoginConfig(state.account)
      }
      res.json(state)
    } catch (err) {
      const message = (err as Error).message
      const status = message === 'No active Claude login flow' ? 409 : 500
      res.status(status).json({ error: message })
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
    let cliCmd: string
    let cliArgs: string[]
    let usingBundled = false
    try {
      const cliPath = resolveClaudeCodeCliPath()
      ensureClaudeCodeCliExecutable(cliPath, logger)
      cliCmd = process.execPath // same node that's running the runner
      cliArgs = [cliPath, 'setup-token']
      usingBundled = true
    } catch (err) {
      logger.warn({ err }, 'Could not resolve bundled Claude Code CLI; falling back to `claude` on PATH')
      cliCmd = 'claude'
      cliArgs = ['setup-token']
    }

    // Prefer requesting the MCP server scope explicitly when supported so the
    // generated token can register in-process MCP servers used by the runner.
    // We keep a compatibility fallback for older CLIs that only support the
    // legacy no-flag flow.
    const requiredScopes = ['user:inference', 'user:mcp_servers'] as const
    const scopeFlag = detectSetupTokenScopeFlag(cliCmd, cliArgs, logger)
    const forceFlag = detectSetupTokenForceFlag(cliCmd, cliArgs, logger)
    const setupTokenArgsBase = scopeFlag === '--scope'
      ? [...cliArgs, '--scope', requiredScopes[0], '--scope', requiredScopes[1]]
      : scopeFlag === '--scopes'
        ? [...cliArgs, '--scopes', requiredScopes.join(',')]
        : [...cliArgs]
    const setupTokenArgs = forceFlag
      ? [...setupTokenArgsBase, forceFlag]
      : setupTokenArgsBase

    // The CLI uses Ink (React-for-terminals) to render the token inside a
    // `<Text>` component. Ink reads `process.stdout.columns` *directly* from
    // the TTY — setting the COLUMNS env var does NOT work. Without a TTY,
    // Ink defaults to 80 columns and hard-wraps the ~108-char OAuth token,
    // giving us a prefix-valid-but-truncated capture that the API then
    // rejects with 401. To fix this we wrap the CLI in `script`, which is
    // installed on every macOS and Linux host and gives the child process
    // a real pseudo-terminal. Inside the PTY we run `stty cols 10000` so
    // Ink doesn't wrap. `script` syntax differs between BSD (macOS) and
    // util-linux (Linux).
    //
    // Native Windows has no `script`/`/dev/tty` and a fundamentally
    // different TTY model (ConPTY). Spawning the CLI directly would
    // reproduce the 80-column truncation bug, so we refuse and tell the
    // user to paste a token manually (WSL users are `process.platform ===
    // 'linux'` and take the script path above).
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      setupTokenRunning = false
      res.status(501).json({
        error: 'PLATFORM_UNSUPPORTED',
        message: 'Automatic token generation is only supported on macOS and Linux. Run `claude setup-token` yourself in a terminal and paste the token into the OAuth token field below.',
      })
      return
    }

    const inner = `stty cols 10000 rows 10000 2>/dev/null; exec ${[cliCmd, ...setupTokenArgs].map(shellQuote).join(' ')}`
    const cmd = 'script'
    const args = process.platform === 'darwin'
      ? ['-q', '/dev/null', 'sh', '-c', inner]   // BSD: script [options] file [command...]
      : ['-q', '-c', inner, '/dev/null']          // util-linux: script [options] -c CMD file

    const spawnEnv = {
      ...process.env,
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      TERM: 'xterm-256color', // script creates a real PTY, so use a sane TERM
      COLUMNS: '10000',
      LINES: '10000',
    }

    // BSD `script` (macOS) calls tcgetattr(STDIN) to copy terminal attrs
    // into the child PTY — it fails with `Operation not supported on
    // socket` if the runner's stdin is not a TTY. Open the controlling
    // terminal directly and pass it as the child's stdin so `script` is
    // happy even when the runner's own stdio is piped. If the runner has
    // no controlling terminal (daemon/service), `/dev/tty` won't open
    // and we fall back to `ignore`, which gives the user a clear error.
    let ttyStdin: number | 'ignore' = 'ignore'
    if (cmd === 'script') {
      try {
        ttyStdin = fs.openSync('/dev/tty', 'r')
      } catch {
        ttyStdin = 'ignore'
      }
    }

    let child
    try {
      child = spawn(cmd, args, {
        stdio: [ttyStdin, 'pipe', 'pipe'],
        env: spawnEnv,
      })
    } catch (err) {
      setupTokenRunning = false
      if (typeof ttyStdin === 'number') {
        try { fs.closeSync(ttyStdin) } catch { /* ignore */ }
      }
      res.status(500).json({ error: 'SPAWN_FAILED', message: (err as Error).message })
      return
    }

    // Close our duplicated /dev/tty fd now that the child owns it.
    if (typeof ttyStdin === 'number') {
      try { fs.closeSync(ttyStdin) } catch { /* ignore */ }
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
        const usingScript = cmd === 'script'
        res.status(404).json({
          error: 'CLI_NOT_FOUND',
          message: usingScript
            ? 'The `script` utility is not installed on the runner host (unusual on macOS/Linux). Install it or paste a token manually.'
            : usingBundled
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

      // Parse token from stdout + stderr combined: Ink may route to either.
      // When wrapped in `script` the PTY produces `\r\n` line endings; we
      // normalise so our extractor regexes are not confused.
      const combined = `${stdout}\n${stderr}`.replace(/\r\n?/g, '\n')
      const token = extractOauthToken(combined)
      const authUrl = extractOauthUrl(combined)

      // Log a short preview (no secrets) so operators can diagnose a future
      // regression in the CLI's output format without re-running the flow.
      logger.info(
        {
          exitCode: code,
          usingBundled,
          scopeFlag: scopeFlag ?? 'none',
          forceFlag: forceFlag ?? 'none',
          requestedScopes: scopeFlag ? requiredScopes.join(',') : null,
          tokenFound: !!token,
          tokenLength: token?.length ?? 0,
          tokenPrefix: token ? `${token.slice(0, 16)}…` : null,
          tokenSuffix: token ? `…${token.slice(-6)}` : null,
          stdoutBytes: stdout.length,
          stderrBytes: stderr.length,
        },
        'claude setup-token finished',
      )

      if (code !== 0 && !token) {
        // `script` fails early if it can't set up a PTY (happens when the
        // runner has no controlling TTY, e.g. daemonised). Give the user a
        // directly-actionable message in that case.
        const scriptPtyFail = cmd === 'script' && /Operation not supported|tcgetattr|no controlling/i.test(stderr)
        res.status(500).json({
          error: scriptPtyFail ? 'NO_CONTROLLING_TTY' : 'SETUP_FAILED',
          exitCode: code,
          message: scriptPtyFail
            ? 'The runner has no controlling terminal, so the Claude Code CLI cannot allocate a PTY for the token flow. Start the runner from a terminal (e.g. `coro runner start` in Terminal.app) and retry, or paste a token generated elsewhere.'
            : undefined,
          stderr: stderr.trim().slice(0, 2000),
          authUrl,
        })
        return
      }

      if (!token) {
        res.status(500).json({
          error: 'NO_TOKEN_IN_OUTPUT',
          stdout: stdout.trim().slice(0, 2000),
          stderr: stderr.trim().slice(0, 2000),
          authUrl,
        })
        return
      }

      res.json({
        token,
        requestedScopes: scopeFlag ? requiredScopes : null,
        scopeRequestSupported: !!scopeFlag,
        forcedReauth: !!forceFlag,
        tokenKind: 'long-lived-inference-only',
        mcpCompatible: false,
        limitation:
          'Claude CLI setup-token produces a long-lived inference-only token in this runner version. It does not provide MCP scopes such as user:mcp_servers.',
        recommendation:
          'Use ANTHROPIC_API_KEY for MCP-enabled workflows in this app. This runner only stores a single OAuth token value and does not persist Claude refresh-token session state.',
      })
    })
  })

  // ── Dashboard (served under /dashboard/) ───────────────────────────────
  //
  // The dashboard now lives in a sibling workspace package (`@coro/dashboard`),
  // so we resolve its built `dist/` relative to the runner's package root and
  // tolerate two layouts:
  //   • compiled:  packages/runner/dist/src/runner/server.js  (4 levels up)
  //   • source:    packages/runner/src/runner/server.ts       (3 levels up)
  // We also accept an env override for non-monorepo deployments.

  const dashboardDir = resolveDashboardDist(logger)
  if (dashboardDir) {
    app.use('/dashboard', express.static(dashboardDir))
    app.get('/dashboard/*', (_req: Request, res: Response) => {
      res.sendFile(path.join(dashboardDir, 'index.html'), err => {
        if (err) res.status(404).json({ error: 'Not found' })
      })
    })
  } else {
    app.get('/dashboard/*', (_req: Request, res: Response) => {
      res.status(503).json({
        error: 'Dashboard build not found',
        hint: 'Run `pnpm --filter @coro/dashboard build` or set CORO_DASHBOARD_DIST.',
      })
    })
  }

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
