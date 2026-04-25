import { Command } from 'commander'
import { loadLocalConfig, detectMode, defaultConfigPath } from '../../src/config/local-config'
import { die } from '../http'

export const runnerCommand = new Command('runner')
  .description('Manage the A5 runner process')

// ── runner start ──────────────────────────────────────────────────────────────

runnerCommand
  .command('start')
  .description('Start the runner (connects to cloud in hybrid mode)')
  .option('--config <path>', 'Path to config file', defaultConfigPath())
  .option('--port <port>', 'Local HTTP server port', '3000')
  .action(async (opts: { config: string; port: string }) => {
    // Dynamic import to avoid loading all runner dependencies at CLI parse time
    const { startRunner } = await import('../../src/runner/index')

    await startRunner({
      configPath: opts.config,
      port: parseInt(opts.port, 10),
    }).catch((err: Error) => {
      die(err.message)
    })
  })

// ── runner status ─────────────────────────────────────────────────────────────

runnerCommand
  .command('status')
  .description('Show runner status and configuration')
  .option('--config <path>', 'Path to config file', defaultConfigPath())
  .action((opts: { config: string }) => {
    const config = loadLocalConfig(opts.config)
    const mode = detectMode(config)

    console.log('\x1b[36m▸\x1b[0m A5 Runner Status\n')
    console.log(`  Config:    ${opts.config}`)
    console.log(`  Mode:      ${mode}`)

    if (config?.cloud) {
      console.log(`  Cloud URL: ${config.cloud.url}`)
    }

    if (config?.anthropic?.apiKey) {
      const key = config.anthropic.apiKey
      console.log(`  API Key:   ${key.slice(0, 10)}...${key.slice(-4)}`)
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
