import { Command } from 'commander'
import { loadLocalConfig, detectMode, defaultConfigPath } from '../../src/config/local-config'
import { die } from '../http'
import { maybeOpenBrowser } from '../browser-open'

interface StartOptions {
  config: string
  port: string
  open?: boolean
}

/**
 * Shared action for `coro start` and `coro runner start`. Boots the runner
 * (which serves the dashboard at `/dashboard/`) and, by default, opens the
 * dashboard in the user's browser once the HTTP listener is ready.
 *
 * The `--open / --no-open` flag plus headless-environment detection
 * (`CI`, `SSH_CONNECTION`, missing `DISPLAY` on Linux, etc.) controls the
 * browser-open behaviour; see `cli/browser-open.ts`.
 */
async function startAction(opts: StartOptions): Promise<void> {
  const port = parseInt(opts.port, 10)

  // Dynamic import to avoid loading all runner dependencies at CLI parse time
  const { startRunner } = await import('../../src/runner/index')

  // Schedule the browser-open eagerly. `maybeOpenBrowser` polls the runner's
  // /healthz endpoint and only opens once the server is actually listening,
  // so we don't race against `startRunner`'s own setup work.
  if (opts.open !== false) {
    void maybeOpenBrowser({ port, explicitlyRequested: opts.open === true })
  }

  await startRunner({
    configPath: opts.config,
    port,
  }).catch((err: Error) => {
    die(err.message)
  })
}

// ── `coro start` (top-level, dashboard-first primary command) ────────────────

export const startCommand = new Command('start')
  .description('Start the Coro runner and open the dashboard (primary command)')
  .option('--config <path>', 'Path to config file', defaultConfigPath())
  .option('--port <port>', 'Local HTTP server port', '3000')
  .option('--no-open', 'Do not open the dashboard in a browser')
  .option('--open', 'Force-open the dashboard even in headless environments')
  .action(startAction)

// ── `coro runner …` (kept for back-compat / power users) ─────────────────────

export const runnerCommand = new Command('runner')
  .description('Manage the Coro runner process (advanced — most users want `coro start`)')

runnerCommand
  .command('start')
  .description('Start the runner (alias of `coro start`)')
  .option('--config <path>', 'Path to config file', defaultConfigPath())
  .option('--port <port>', 'Local HTTP server port', '3000')
  .option('--no-open', 'Do not open the dashboard in a browser')
  .option('--open', 'Force-open the dashboard even in headless environments')
  .action(startAction)

// ── runner status ─────────────────────────────────────────────────────────────

runnerCommand
  .command('status')
  .description('Show runner status and configuration')
  .option('--config <path>', 'Path to config file', defaultConfigPath())
  .action((opts: { config: string }) => {
    const config = loadLocalConfig(opts.config)
    const mode = detectMode(config)

    console.log('\x1b[36m▸\x1b[0m Coro Runner Status\n')
    console.log(`  Config:    ${opts.config}`)
    console.log(`  Mode:      ${mode}`)

    if (config?.cloud) {
      console.log(`  Cloud URL: ${config.cloud.url}`)
    }

    // Read the LLM provider key from the modern plugin slot, with a
    // legacy fallback so old configs still surface a status line.
    const installedAnthropic = config?.plugins?.installed?.['anthropic']?.config as
      | { method?: string; apiKey?: string }
      | undefined
    const apiKey =
      (installedAnthropic?.method === 'apiKey' && typeof installedAnthropic.apiKey === 'string'
        ? installedAnthropic.apiKey
        : undefined)
      ?? (config?.anthropic?.method === 'apiKey' ? config.anthropic.apiKey : undefined)
    if (apiKey) {
      console.log(`  API Key:   ${apiKey.slice(0, 10)}...${apiKey.slice(-4)}`)
    }

    if (config?.intelligence) {
      console.log(`  Intel dir: ${config.intelligence.dir}`)
    }

    if (config?.paths?.workingDir) {
      console.log(`  Work dir:  ${config.paths.workingDir}`)
    }

    if (config?.git) {
      console.log(`  Git:       ${config.git.provider} (${config.git.username})`)
    }

    console.log()
  })

// ── runner stop ───────────────────────────────────────────────────────────────

runnerCommand
  .command('stop')
  .description('Stop the runner process')
  .action(() => {
    // For now, runner is a foreground process — Ctrl+C stops it.
    // Future: daemon mode with PID file.
    console.log('The runner runs in the foreground — press Ctrl+C to stop it.')
    console.log('Future: daemon mode with `coro runner start --daemon`')
  })
