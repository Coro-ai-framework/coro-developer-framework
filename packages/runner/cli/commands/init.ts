import { Command } from 'commander'
import os from 'os'
import {
  loadLocalConfig,
  saveLocalConfig,
  defaultConfigPath,
  defaultIntelligenceDir,
  defaultWorkingDir,
  type LocalConfig,
} from '../../src/config/local-config'
import { BUILTIN_PLUGIN_IDS_BY_KIND } from '../../src/plugins/builtin'
import { die } from '../http'

// Built-in SCM plugin ids (`bitbucket`, `github`, …). Sourced from the
// registry's static-id index so adding a new SCM plugin in
// `plugins/builtin/` automatically appears in `--scm` validation here.
function builtinScmIds(): readonly string[] {
  return BUILTIN_PLUGIN_IDS_BY_KIND.scm
}

export const initCommand = new Command('init')
  .description(
    'Initialize the Coro runner configuration (advanced — most users should ' +
    'instead run `coro start` and complete setup in the dashboard).',
  )
  .option('--local', 'Configure for local-only mode (no cloud)')
  .option('--api-key <key>', 'Anthropic API key')
  .option('--intelligence-dir <dir>', 'Intelligence directory', defaultIntelligenceDir())
  .option('--working-dir <dir>', 'Working directory', defaultWorkingDir())
  // P6: --scm replaces the old --git-provider. The legacy `git.*`
  // config block was removed; credentials now persist exclusively under
  // `plugins.installed.{github|bitbucket}.config`.
  .option('--scm <pluginId>', `SCM plugin id (one of: ${builtinScmIds().join(', ')})`)
  .option('--git-username <username>', 'Git username (GitHub: org owner; BitBucket: account email or x-*-auth)')
  .option('--git-token <token>', 'Git access token (PAT for GitHub; App Password / API token for BitBucket)')
  .option('--git-workspace <workspace>', 'Git workspace/org (GitHub: org name; BitBucket: workspace slug)')
  .option('--intelligence-remote <url>', 'Intelligence git remote URL')
  .action(async (opts: {
    local?: boolean
    apiKey?: string
    intelligenceDir: string
    workingDir: string
    scm?: string
    gitUsername?: string
    gitToken?: string
    gitWorkspace?: string
    intelligenceRemote?: string
  }) => {
    const readline = await import('readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const ask = (q: string, def?: string): Promise<string> =>
      new Promise(r => rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => r(a || def || '')))

    console.log('\x1b[36m▸\x1b[0m Coro Runner Configuration\n')

    const existing = loadLocalConfig() ?? {}

    // Anthropic API key — `coro init` only supports the API-key method today;
    // users can switch to OAuth from the dashboard Settings page after init.
    // Anthropic credentials live under `plugins.installed.anthropic.config`
    // (the legacy top-level `anthropic` block was removed earlier).
    const installedAnthropic = existing.plugins?.installed?.['anthropic']?.config as
      | { method?: string; apiKey?: string }
      | undefined
    const existingApiKey =
      installedAnthropic?.method === 'apiKey' && typeof installedAnthropic.apiKey === 'string'
        ? installedAnthropic.apiKey
        : ''
    const apiKey = opts.apiKey
      ?? await ask('Anthropic API key', existingApiKey || process.env.ANTHROPIC_API_KEY || '')
    if (!apiKey) die('Anthropic API key is required')

    // SCM plugin selection. Falls back to whichever SCM plugin is
    // already installed; otherwise prompts.
    const scmIds = builtinScmIds()
    const existingInstalledScm = scmIds.find(id => existing.plugins?.installed?.[id])
    let scmId = opts.scm ?? existingInstalledScm
    if (!scmId) {
      scmId = await ask(`SCM plugin (${scmIds.join('/')})`, scmIds[0] ?? 'github')
    }
    if (scmId && !scmIds.includes(scmId)) {
      die(`Unknown SCM plugin "${scmId}". Available: ${scmIds.join(', ')}.`)
    }

    // Existing plugin-installed creds, used as defaults during prompts.
    const installedScmConfig = (existing.plugins?.installed?.[scmId]?.config ?? {}) as
      Record<string, string | undefined>

    // Per-plugin field labels and defaults. Each plugin's own Zod
    // schema is the canonical contract; we only handle the built-in
    // shapes here. Drop-in plugins (e.g. `gitlab`) configure
    // themselves through the dashboard.
    const isBitbucket = scmId === 'bitbucket'
    const gitUsername = opts.gitUsername ?? await ask(
      isBitbucket ? 'BitBucket coder username (email or x-*-auth)' : 'GitHub owner / org',
      isBitbucket ? installedScmConfig['coderUsername'] : installedScmConfig['owner'],
    )
    const gitToken = opts.gitToken ?? await ask(
      isBitbucket ? 'BitBucket coder token (App Password or API token)' : 'GitHub personal access token',
      isBitbucket ? installedScmConfig['coderToken'] : installedScmConfig['token'],
    )
    const gitWorkspace = isBitbucket
      ? (opts.gitWorkspace ?? await ask('BitBucket workspace slug', installedScmConfig['workspace']))
      : undefined

    // Intelligence directory
    const intelligenceDir = opts.intelligenceDir.replace('~', os.homedir())

    // Intelligence git remote
    const intelligenceRemote = opts.intelligenceRemote ?? await ask(
      'Intelligence git remote URL (optional)',
      existing.intelligence?.gitRemote,
    )

    rl.close()

    // Build the plugin-installed entry for the chosen SCM. Each
    // plugin's Zod schema (`bbConfigSchema`, `ghConfigSchema`) is the
    // canonical contract — we match its field names exactly.
    const scmEntry: { enabled: true; config: Record<string, string> } | undefined =
      gitUsername && gitToken
        ? scmId === 'bitbucket'
          ? {
              enabled: true,
              config: {
                workspace: gitWorkspace ?? '',
                coderUsername: gitUsername,
                coderToken: gitToken,
              },
            }
          : scmId === 'github'
            ? {
                enabled: true,
                config: { owner: gitUsername, token: gitToken },
              }
            : undefined
        : undefined

    const config: LocalConfig = {
      ...existing,
      plugins: {
        ...(existing.plugins ?? {}),
        installed: {
          ...(existing.plugins?.installed ?? {}),
          anthropic: {
            enabled: true,
            config: { method: 'apiKey', apiKey },
          },
          ...(scmEntry ? { [scmId]: scmEntry } : {}),
        },
        ...(scmEntry
          ? {
              defaults: {
                ...(existing.plugins?.defaults ?? {}),
                scm: scmId,
              },
            }
          : {}),
      },
      intelligence: {
        dir: intelligenceDir,
        ...(intelligenceRemote ? { gitRemote: intelligenceRemote } : {}),
      },
      paths: { workingDir: opts.workingDir.replace('~', os.homedir()) },
    }

    if (opts.local) {
      // Remove cloud config for local-only mode
      delete (config as Record<string, unknown>).cloud
    }

    saveLocalConfig(config)

    console.log()
    console.log(`\x1b[32m✓\x1b[0m Configuration saved to ${defaultConfigPath()}`)
    console.log()
    console.log(`  Intelligence: ${intelligenceDir}`)
    console.log(`  Working dir:  ${config.paths?.workingDir}`)
    console.log(`  SCM plugin:   ${scmId}`)
    console.log(`  Mode:         ${config.cloud ? 'hybrid' : 'local'}`)
    console.log()

    console.log('Next: run \x1b[36mcoro start\x1b[0m — the dashboard is the primary way to')
    console.log('manage Coro from here on. The CLI remains available for scripting / CI.')
    if (!config.cloud) {
      console.log('Run \x1b[36mcoro login\x1b[0m first to enable cloud/team features.')
    }
  })
