import { Command } from 'commander'
import os from 'os'
import path from 'path'
import {
  loadLocalConfig,
  saveLocalConfig,
  defaultConfigPath,
  defaultIntelligenceDir,
  defaultWorkingDir,
  type LocalConfig,
} from '../../src/config/local-config'
import { die } from '../http'

export const initCommand = new Command('init')
  .description('Initialize the A5 runner configuration')
  .option('--local', 'Configure for local-only mode (no cloud)')
  .option('--api-key <key>', 'Anthropic API key')
  .option('--intelligence-dir <dir>', 'Intelligence directory', defaultIntelligenceDir())
  .option('--working-dir <dir>', 'Working directory', defaultWorkingDir())
  .option('--git-provider <provider>', 'Git provider (bitbucket, github, gitlab)', 'bitbucket')
  .option('--git-username <username>', 'Git username')
  .option('--git-token <token>', 'Git access token')
  .option('--git-workspace <workspace>', 'Git workspace/org (BitBucket workspace slug)')
  .option('--intelligence-remote <url>', 'Intelligence git remote URL')
  .action(async (opts: {
    local?: boolean
    apiKey?: string
    intelligenceDir: string
    workingDir: string
    gitProvider: string
    gitUsername?: string
    gitToken?: string
    gitWorkspace?: string
    intelligenceRemote?: string
  }) => {
    const readline = await import('readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const ask = (q: string, def?: string): Promise<string> =>
      new Promise(r => rl.question(def ? `${q} [${def}]: ` : `${q}: `, (a) => r(a || def || '')))

    console.log('\x1b[36m▸\x1b[0m A5 Runner Configuration\n')

    const existing = loadLocalConfig() ?? { anthropic: { apiKey: '' } }

    // Anthropic API key
    const apiKey = opts.apiKey
      ?? await ask('Anthropic API key', existing.anthropic?.apiKey || process.env.ANTHROPIC_API_KEY || '')
    if (!apiKey) die('Anthropic API key is required')

    // Git provider
    const gitProvider = opts.gitProvider as 'bitbucket' | 'github' | 'gitlab'

    // Git credentials (interactive if not provided)
    const gitUsername = opts.gitUsername ?? await ask('Git username', existing.git?.username)
    const gitToken = opts.gitToken ?? await ask('Git access token', existing.git?.token)
    const gitWorkspace = opts.gitWorkspace ?? await ask(
      `Git workspace${gitProvider === 'bitbucket' ? ' (BB workspace slug)' : ' (org name)'}`,
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

    // Build config
    const config: LocalConfig = {
      ...existing,
      anthropic: { apiKey },
      intelligence: {
        dir: intelligenceDir,
        ...(intelligenceRemote ? { gitRemote: intelligenceRemote } : {}),
      },
      paths: { workingDir: opts.workingDir.replace('~', os.homedir()) },
      git: gitUsername && gitToken ? {
        provider: gitProvider,
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
    console.log(`  Git provider: ${gitProvider}`)
    console.log(`  Mode:         ${config.cloud ? 'hybrid' : 'local'}`)
    console.log()

    if (config.cloud) {
      console.log('Run \x1b[36ma5 runner start\x1b[0m to start the hybrid runner')
    } else {
      console.log('Run \x1b[36ma5 runner start\x1b[0m to start in local mode')
      console.log('Run \x1b[36ma5 login\x1b[0m first to enable cloud/team features')
    }
  })
