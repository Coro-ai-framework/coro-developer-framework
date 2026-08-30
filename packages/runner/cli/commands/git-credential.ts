// ── coro git-credential ──────────────────────────────────────────────────────
//
// Git credential helper. Invoked by git as
//   <coro> git-credential get|store|erase
// with the helper protocol on stdin. Humans should not run this.
//
// stdout is the protocol and must stay empty except `username=` /
// `password=` on `get`. Logs go nowhere — a stray line breaks auth.

import { Command } from 'commander'
import pino from 'pino'
import { resolveContributionCredential } from '../../src/config/contribution-credential'
import {
  loadLocalConfig,
  resolvePluginsConfig,
  resolveUpstreamConfig,
} from '../../src/config/local-config'
import { buildScmPluginRegistry } from '../../src/plugins/builtin'
import { runGitCredentialHelper } from '../../src/clients/git-auth'

async function handle(operation: string): Promise<void> {
  try {
    if (operation !== 'get') return
    const stdin = await readStdin()
    const logger = pino({ level: 'silent' })
    const config = loadLocalConfig()
    // Writes to the contribution fork authenticate as the account that
    // created it, which is not the SCM plugin's account whenever the install
    // configured a separate `upstream.token`.
    const contribution = resolveContributionCredential(resolveUpstreamConfig(config))
    const registry = await buildScmPluginRegistry({
      pluginsConfig: resolvePluginsConfig(config),
      logger,
      ...(contribution ? { contributionCredential: contribution } : {}),
    })
    const body = await runGitCredentialHelper({
      operation,
      stdin,
      registry,
      ...(contribution ? { contribution } : {}),
    })
    if (body) process.stdout.write(body)
  } catch {
    // Fail closed: print nothing so git does not learn a host helper
    // identity. Exit 0 so git does not retry osxkeychain.
  }
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('')
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (c: Buffer) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    process.stdin.on('error', reject)
  })
}

export const gitCredentialCommand = new Command('git-credential')
  .description('Git credential helper (invoked by git, not humans)')
  .argument('[operation]', 'get | store | erase')
  .allowUnknownOption()
  .helpOption(false)
  .action(async (operation: string | undefined) => {
    await handle(operation ?? 'get')
  })
