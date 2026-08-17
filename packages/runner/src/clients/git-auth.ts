// ── Live SCM git credentials ─────────────────────────────────────────────────
//
// Jobs used to snapshot the plugin token into `origin` (`https://user:token@…`).
// `git push` then authenticated as whoever owned that snapshot, not whoever
// Settings currently shows. This module is the single path that replaces that:
//
//   1. `cloneInfo().url` is stored without secrets.
//   2. `coro git-credential` answers git's helper protocol from the live
//      SCM plugin (`resolveByRemote` → username/password).
//   3. Each checkout gets a repo-local helper that *resets* host helpers
//      (Xcode osxkeychain) so they cannot override the plugin.
//
// The runner never hard-codes `x-access-token` / Bitbucket usernames —
// those stay inside the plugin that produced `cloneInfo`.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git'
import type { ScmCloneInfo, ScmPluginRuntime } from '../plugins/types'
import type { PluginRegistry } from '../plugins/registry'

const execFileAsync = promisify(execFile)

const WALK_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.coro',
  'dist',
  'build',
  '.next',
  '.cache',
  '.pnpm-home',
  '_intelligence',
])

export interface GitCredentialRequest {
  protocol: string
  host: string
  path?: string
}

export interface GitHttpsCredentials {
  username: string
  password: string
}

// ── URL / cloneInfo ──────────────────────────────────────────────────────────

/** Strip HTTPS userinfo. SSH and non-URLs are returned unchanged. */
export function stripUrlUserinfo(raw: string): string {
  const trimmed = raw.trim()
  if (!/^https?:\/\//i.test(trimmed)) return trimmed
  try {
    const parsed = new URL(trimmed)
    if (!parsed.username && !parsed.password) return trimmed
    parsed.username = ''
    parsed.password = ''
    return parsed.toString().replace(/^(https?:\/\/)@/i, '$1')
  } catch {
    return trimmed.replace(/^(https?:\/\/)[^@/?#]+@/i, '$1')
  }
}

/**
 * HTTPS credentials from a plugin's `cloneInfo`. Prefers the explicit
 * fields; falls back to userinfo on `url` so an older drop-in that still
 * embeds a token keeps working for one release.
 */
export function httpsCredentialsFromCloneInfo(info: ScmCloneInfo): GitHttpsCredentials | null {
  if (info.username && info.password) {
    return { username: info.username, password: info.password }
  }
  return credentialsFromUrlUserinfo(info.url)
}

function credentialsFromUrlUserinfo(raw: string): GitHttpsCredentials | null {
  if (!/^https?:\/\//i.test(raw)) return null
  try {
    const parsed = new URL(raw)
    if (!parsed.password) return null
    return {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    }
  } catch {
    return null
  }
}

export function persistableCloneUrl(info: ScmCloneInfo): string {
  return stripUrlUserinfo(info.url)
}

// ── Git credential helper protocol ───────────────────────────────────────────

export function parseGitCredentialRequest(stdin: string): GitCredentialRequest | null {
  const fields: Record<string, string> = {}
  for (const line of stdin.split(/\r?\n/)) {
    if (!line) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    fields[line.slice(0, eq)] = line.slice(eq + 1)
  }
  const protocol = fields['protocol']
  const host = fields['host']
  if (!protocol || !host) return null
  const pathField = fields['path']
  return {
    protocol,
    host,
    ...(pathField ? { path: pathField } : {}),
  }
}

export function formatGitCredentialResponse(creds: GitHttpsCredentials): string {
  return `username=${creds.username}\npassword=${creds.password}\n`
}

export function remoteUrlFromCredentialRequest(req: GitCredentialRequest): string {
  const suffix = (req.path ?? '').replace(/^\/+/, '')
  return `${req.protocol}://${req.host}/${suffix}`
}

/**
 * Look up live HTTPS credentials for a git helper request. Returns
 * `null` when no installed SCM plugin claims the host — the helper
 * then prints nothing so git does not fall through to osxkeychain
 * (the repo-local helper list is reset first).
 */
export function fillGitCredential(
  req: GitCredentialRequest,
  registry: PluginRegistry,
): GitHttpsCredentials | null {
  const remote = remoteUrlFromCredentialRequest(req)
  const scm = registry.resolveByRemote(remote)
  if (!scm) return null
  const repoHint = repoHintFromRequest(req, scm)
  return httpsCredentialsFromCloneInfo(scm.cloneInfo({ repo: repoHint }))
}

function repoHintFromRequest(req: GitCredentialRequest, scm: ScmPluginRuntime): string {
  const raw = (req.path ?? '').replace(/\.git$/i, '').replace(/^\/+/, '')
  if (raw) return raw
  return scm.manifest.id
}

export async function runGitCredentialHelper(args: {
  operation: string
  stdin: string
  registry: PluginRegistry
}): Promise<string> {
  if (args.operation !== 'get') return ''
  const req = parseGitCredentialRequest(args.stdin)
  if (!req) return ''
  const creds = fillGitCredential(req, args.registry)
  return creds ? formatGitCredentialResponse(creds) : ''
}

// ── Helper command installed into repo-local git config ──────────────────────

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function gitCredentialHelperCommand(override?: { argv: readonly string[] }): string {
  const argv = override?.argv ?? defaultHelperArgv()
  return `!${argv.map(shellQuote).join(' ')}`
}

function defaultHelperArgv(): string[] {
  const script = process.argv[1]
  return [
    process.execPath,
    ...process.execArgv,
    ...(script ? [script] : []),
    'git-credential',
  ]
}

/** Env that makes a one-shot git spawn use only the Coro helper. */
export function gitCredentialHelperSpawnEnv(helperCommand?: string): Record<string, string> {
  const helper = helperCommand ?? gitCredentialHelperCommand()
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: helper,
  }
}

export function isolatedGitEnv(extra?: Record<string, string>): Record<string, string> {
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nullDevice,
    ...gitCredentialHelperSpawnEnv(),
    ...extra,
  }
}

export function createIsolatedGit(cwd: string, extraEnv?: Record<string, string>): SimpleGit {
  const opts: Partial<SimpleGitOptions> = {
    baseDir: cwd,
    unsafe: {
      allowUnsafeProtocolOverride: false,
      allowUnsafeAskPass: true,
      allowUnsafeConfigPaths: true,
    } as unknown as SimpleGitOptions['unsafe'],
  }
  return simpleGit(opts).env(isolatedGitEnv(extraEnv))
}

// ── Checkout prepare (clone reuse + phase start) ─────────────────────────────

export interface InstallRepoGitAuthOptions {
  matchesRemote: (url: string) => boolean
  helperCommand?: string
}

/**
 * Rewrite HTTPS remotes that belong to an installed SCM plugin so they
 * carry no userinfo, then install the repo-local credential helper
 * (empty helper first, so osxkeychain is not consulted).
 */
export async function installRepoGitAuth(
  repoDir: string,
  opts: InstallRepoGitAuthOptions,
): Promise<void> {
  const remotes = await gitLines(repoDir, ['remote'])
  for (const remote of remotes) {
    const url = (await gitOutput(repoDir, ['remote', 'get-url', remote])).trim()
    if (!url || !opts.matchesRemote(url)) continue
    const clean = stripUrlUserinfo(url)
    if (clean !== url) {
      await gitOutput(repoDir, ['remote', 'set-url', remote, clean])
    }
  }

  const helper = opts.helperCommand ?? gitCredentialHelperCommand()
  await gitOutput(repoDir, ['config', '--local', '--unset-all', 'credential.helper']).catch(() => undefined)
  await gitOutput(repoDir, ['config', '--local', 'credential.helper', ''])
  await gitOutput(repoDir, ['config', '--local', '--add', 'credential.helper', helper])
}

export async function prepareJobGitAuth(
  jobWorkingDir: string,
  registry: PluginRegistry,
  helperCommand?: string,
): Promise<void> {
  const checkouts = await findGitCheckouts(jobWorkingDir)
  for (const repoDir of checkouts) {
    await installRepoGitAuth(repoDir, {
      matchesRemote: url => Boolean(registry.resolveByRemote(url)),
      ...(helperCommand ? { helperCommand } : {}),
    })
  }
}

export async function findGitCheckouts(root: string): Promise<string[]> {
  const found: string[] = []
  await walkForGit(root, found)
  return found
}

async function walkForGit(dir: string, found: string[]): Promise<void> {
  const names = await fs.readdir(dir).catch(() => null)
  if (!names) return
  if (names.includes('.git')) {
    found.push(dir)
    return
  }
  for (const name of names) {
    if (WALK_SKIP_DIRS.has(name)) continue
    const child = path.join(dir, name)
    const stat = await fs.stat(child).catch(() => null)
    if (!stat?.isDirectory()) continue
    await walkForGit(child, found)
  }
}

async function gitOutput(repoDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoDir, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
  })
  return stdout
}

async function gitLines(repoDir: string, args: string[]): Promise<string[]> {
  const out = await gitOutput(repoDir, args)
  return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
}
