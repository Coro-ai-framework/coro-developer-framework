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
  // P6: --scm replaces --git-provider. We keep --git-provider as a
  // hidden alias for one release so existing scripts don't break — the
  // legacyConfigToPlugins translator maps `git.provider` to the right
  // SCM plugin id at runtime.
  .option('--scm <pluginId>', `SCM plugin id (one of: ${builtinScmIds().join(', ')})`)
  .option('--git-provider <provider>', '[deprecated] alias for --scm; use --scm instead')
  .option('--git-username <username>', 'Git username')
  .option('--git-token <token>', 'Git access token')
  .option('--git-workspace <workspace>', 'Git workspace/org')
  .option('--intelligence-remote <url>', 'Intelligence git remote URL')
  .action(async (opts: {
    local?: boolean
    apiKey?: string
    intelligenceDir: string
    workingDir: string
    scm?: string
    gitProvider?: string
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

    const existing = loadLocalConfig() ?? { anthropic: { method: 'apiKey' as const, apiKey: '' } }

    // Anthropic API key — `coro init` only supports the API-key method today;
    // users can switch to OAuth from the dashboard Settings page after init.
    const existingApiKey = existing.anthropic?.method === 'apiKey' ? existing.anthropic.apiKey : ''
    const apiKey = opts.apiKey
      ?? await ask('Anthropic API key', existingApiKey || process.env.ANTHROPIC_API_KEY || '')
    if (!apiKey) die('Anthropic API key is required')

    // SCM plugin selection. --scm wins over --git-provider; both fall
    // back to whatever the existing config has, otherwise we walk the
    // built-in registry and prompt the user.
    const scmIds = builtinScmIds()
    if (opts.gitProvider && !opts.scm) {
      console.warn('\x1b[33m⚠\x1b[0m  --git-provider is deprecated; use --scm instead.')
    }
    const requestedScm = opts.scm ?? opts.gitProvider ?? existing.git?.provider
    let scmId = requestedScm
    if (!scmId) {
      scmId = await ask(`SCM plugin (${scmIds.join('/')})`, scmIds[0] ?? 'github')
    }
    if (scmId && !scmIds.includes(scmId)) {
      die(`Unknown SCM plugin "${scmId}". Available: ${scmIds.join(', ')}.`)
    }

    // Git credentials (interactive if not provided)
    const gitUsername = opts.gitUsername ?? await ask('Git username', existing.git?.username)
    const gitToken = opts.gitToken ?? await ask('Git access token', existing.git?.token)
    const gitWorkspace = opts.gitWorkspace ?? await ask(
      `Git workspace${scmId === 'bitbucket' ? ' (BB workspace slug)' : ' (org name)'}`,
      existing.git?.workspace,
    )

    // Intelligence directory
    const intelligenceDir = opts.intelligenceDir.replace('~', os.homedir())

    // Intelligence git remote
    const intelligenceRemote = opts.intelligenceRemote ?? await ask(
      'Intelligence git remote URL (optional)',
      existing.intelligence?.gitRemote,
    )

    rl.close()

    // Persist credentials in the legacy `git` block so the
    // `legacyConfigToPlugins` translator picks the right SCM plugin
    // at runner startup. The new top-level `plugins` block is left
    // for advanced users to opt into manually until the dashboard
    // grows full plugin-config write support.
    const provider = scmId === 'bitbucket' || scmId === 'github' || scmId === 'gitlab'
      ? scmId
      : 'github'

    const config: LocalConfig = {
      ...existing,
      anthropic: { method: 'apiKey', apiKey },
      intelligence: {
        dir: intelligenceDir,
        ...(intelligenceRemote ? { gitRemote: intelligenceRemote } : {}),
      },
      paths: { workingDir: opts.workingDir.replace('~', os.homedir()) },
      git: gitUsername && gitToken ? {
        provider,
        username: gitUsername,
        token: gitToken,
        ...(gitWorkspace ? { workspace: gitWorkspace } : {}),
      } : existing.git,
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
