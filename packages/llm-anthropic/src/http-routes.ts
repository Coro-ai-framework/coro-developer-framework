// ── Anthropic plugin HTTP routes ────────────────────────────────────────────
//
// Express endpoints owned by the Anthropic plugin: the Claude OAuth login
// flow used by the dashboard's Settings → Authentication panel, and the
// `claude setup-token` shell-out that mints a long-lived inference token.
//
// These routes used to live in `packages/runner/src/runner/server.ts`;
// they were extracted so the runner core has no Anthropic-specific
// surface. The plugin registers them via {@link PluginRuntime.registerHttpRoutes}
// at startup. No behaviour change vs. the previous server.ts implementation.

import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import type { PluginHttpRoutesContext } from '@coro-ai/plugin-sdk'
import { ClaudeLoginManager } from './login'
import { normalizeClaudeLoginStatus } from './oauth-status'
import { ensureClaudeCodeCliExecutable, resolveClaudeCodeCliPath } from './cli-path'
import { resetRefreshCooldown } from './credential-store'

/**
 * Register the Anthropic-specific HTTP routes against the runner's
 * Express app. Idempotent only in the sense that registering twice
 * would yield duplicate handlers — call exactly once at startup.
 */
export function registerAnthropicHttpRoutes(ctx: PluginHttpRoutesContext): void {
  const { app, logger, savePluginConfig } = ctx
  const claudeLoginManager = new ClaudeLoginManager({ logger })

  function saveClaudeLoginConfig(account?: {
    email?: string
    organization?: string
    subscriptionType?: string
    tokenSource?: string
    apiKeySource?: string
    apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'mantle'
  }) {
    // A fresh login means any earlier refresh failure is stale — drop the
    // cooldown so the next probe uses the new session immediately.
    resetRefreshCooldown()
    // Persist into the modern plugin slot so the runner's resolver
    // picks up the credentials at job start. The legacy top-level
    // `anthropic` block was removed in Phase F of the
    // Anthropic-as-plugin migration.
    savePluginConfig('anthropic', {
      method: 'claudeLogin',
      account,
    })
  }

  // ── /config/anthropic/claude-login/{status,start,callback} ───────────────

  app.get('/config/anthropic/claude-login/status', ((_req: unknown, res: any) => {
    try {
      const raw = claudeLoginManager.getState()
      if (raw.status === 'connected') {
        saveClaudeLoginConfig(raw.account)
      }
      res.json(normalizeClaudeLoginStatus(raw))
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as any)

  app.post('/config/anthropic/claude-login/start', (async (req: any, res: any) => {
    try {
      const forceReauth = req.body?.force === true
      const raw = await claudeLoginManager.start({ forceReauth })
      if (raw.status === 'connected') {
        saveClaudeLoginConfig(raw.account)
      }
      res.json(normalizeClaudeLoginStatus(raw))
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  }) as any)

  app.post('/config/anthropic/claude-login/callback', (async (req: any, res: any) => {
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

      const raw = await claudeLoginManager.submitCallback({
        authorizationCode,
        state: callbackState,
      })
      if (raw.status === 'connected') {
        saveClaudeLoginConfig(raw.account)
      }
      res.json(normalizeClaudeLoginStatus(raw))
    } catch (err) {
      const message = (err as Error).message
      const status = message === 'No active Claude login flow' ? 409 : 500
      res.status(status).json({ error: message })
    }
  }) as any)

  // ── /config/anthropic/generate-oauth-token ───────────────────────────────
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

  app.post('/config/anthropic/generate-oauth-token', ((_req: unknown, res: any) => {
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
  }) as any)
}

// ── Helpers (module-private) ────────────────────────────────────────────────

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
function detectSetupTokenScopeFlag(
  cliCmd: string,
  cliArgs: string[],
  logger: PluginHttpRoutesContext['logger'],
): '--scope' | '--scopes' | null {
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
function detectSetupTokenForceFlag(
  cliCmd: string,
  cliArgs: string[],
  logger: PluginHttpRoutesContext['logger'],
): string | null {
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
