import fs from 'node:fs'
import path from 'node:path'
import { git } from './git'
import type { Scenario } from './scenario'
import { resolvePath } from './util'
import type { Task } from './tasks'

/**
 * Everything one attempt needs on disk, kept apart from every other attempt.
 *
 * One `HOME` per attempt is the isolation mechanism. Coro keeps its SQLite
 * state at `~/.coro/state.db`, its job working directories, its simulated
 * pull-request store (`~/.coro/local-scm`) and any tenant memory under that
 * directory, so pointing HOME somewhere fresh gives each attempt a clean
 * install. It also keeps the developer's own `~/.claude` settings and
 * `~/.gitconfig` out of the result.
 *
 * The workspace lives under the OS temp directory, deliberately *outside* the
 * Coro checkout: Claude Code walks up from its working directory collecting
 * CLAUDE.md files, and this repository's CLAUDE.md is a developer guide that
 * must never reach the agent being evaluated.
 */

// ── Credentials ──────────────────────────────────────────────────────────────

export interface Credentials {
  method: 'apiKey' | 'oauth'
  secret: string
}

/**
 * Read the credentials the runner will use from the harness's own environment.
 *
 * The runner under test does not inherit your installed Coro's config, so it
 * does not use the same login. A Claude Code login (Coro's default `claudeLogin`
 * method) cannot carry over either: on macOS it lives in the login keychain,
 * which the system finds through HOME, and each attempt runs with an isolated
 * HOME. An API key bills that API account's credits; a `claude setup-token`
 * token uses the Claude subscription.
 */
export function resolveCredentials(env: NodeJS.ProcessEnv = process.env): Credentials {
  const apiKey = env['ANTHROPIC_API_KEY']?.trim()
  if (apiKey) return { method: 'apiKey', secret: apiKey }
  const oauth = env['CLAUDE_CODE_OAUTH_TOKEN']?.trim()
  if (oauth) return { method: 'oauth', secret: oauth }
  throw new Error(
    'No Anthropic credentials found. Set ANTHROPIC_API_KEY (an API key, billed to that account) or ' +
      'CLAUDE_CODE_OAUTH_TOKEN (a Claude subscription token from `claude setup-token`) in the environment ' +
      'that runs coro-eval. Your Claude Code login is not usable here because each attempt runs with an isolated HOME.',
  )
}

/**
 * What a run will authenticate with, for people to read: the variable it came
 * from and what it is billed to. Never includes the value.
 */
export function describeCredentials(credentials: Credentials): string {
  return credentials.method === 'apiKey'
    ? 'API key from ANTHROPIC_API_KEY (billed to that API account\'s credits; takes precedence over CLAUDE_CODE_OAUTH_TOKEN)'
    : 'subscription token from CLAUDE_CODE_OAUTH_TOKEN (counts against your Claude plan)'
}

// ── The runner's config ──────────────────────────────────────────────────────

export interface BuildConfigArgs {
  scenario: Scenario
  credentials: Credentials
  /** Where the runner clones repositories for jobs. */
  workingDir: string
}

/**
 * The `config.json` the runner is started with. Only the keys the scenario
 * controls are written; everything else is left to the runner's defaults.
 */
export function buildCoroConfig({ scenario, credentials, workingDir }: BuildConfigArgs): Record<string, unknown> {
  const aliases: Record<string, { provider: string; model: string }> = {}
  for (const [tier, model] of Object.entries(scenario.models)) {
    const entry = { provider: 'anthropic', model }
    aliases[tier] = entry
    // Model resolution reads `tier:<tier>` before the bare shorthand, so both are set.
    if (!tier.includes(':')) aliases[`tier:${tier}`] = entry
  }

  const config: Record<string, unknown> = {
    plugins: {
      defaults: { scm: 'local' },
      installed: {
        local: { enabled: true, config: {} },
        anthropic: {
          enabled: true,
          config:
            credentials.method === 'apiKey'
              ? { method: 'apiKey', apiKey: credentials.secret }
              : { method: 'oauth', oauthToken: credentials.secret },
        },
      },
    },
    paths: { workingDir },
    llm: {
      defaultProvider: 'anthropic',
      ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
    },
    codeReview: { lenses: scenario.codeReviewLenses },
  }

  if (scenario.tenantOverlayDir) {
    config['tenant'] = { overlay: { kind: 'localDir', path: resolvePath(scenario.tenantOverlayDir) } }
  }
  return config
}

const REDACTED = '<redacted>'

/** Copy of `config` with credentials blanked, safe to keep next to the results. */
export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(config)
  const installed = (copy['plugins'] as { installed?: Record<string, { config?: Record<string, unknown> }> } | undefined)
    ?.installed
  for (const slot of Object.values(installed ?? {})) {
    for (const key of Object.keys(slot.config ?? {})) {
      if (/key|token|secret|password/i.test(key)) slot.config![key] = REDACTED
    }
  }
  return copy
}

export function redactConfigFile(configPath: string): void {
  if (!fs.existsSync(configPath)) return
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
  fs.writeFileSync(configPath, JSON.stringify(redactConfig(config), null, 2))
}

// ── Environment for child processes ──────────────────────────────────────────

export interface Caches {
  npm: string
  goMod: string
  goBuild: string
}

export function cachePaths(cacheRoot: string): Caches {
  return {
    npm: path.join(cacheRoot, 'npm'),
    goMod: path.join(cacheRoot, 'go-mod'),
    goBuild: path.join(cacheRoot, 'go-build'),
  }
}

/** Variables that would let the developer's setup steer a run. */
const STRIPPED_EXACT = new Set([
  // Model selection must come from the scenario; env overrides trump config in the runner.
  'CORO_PLANNING_MODEL',
  'CORO_CODING_MODEL',
  'CLAUDE_PLANNING_MODEL',
  'CLAUDE_CODING_MODEL',
  'CORO_DEFAULT_PROVIDER',
  // Set when the harness is launched from inside a Claude Code session.
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_EXECPATH',
  // Redirect where a shell reads its startup files. A terminal with shell
  // integration (Cursor, VS Code) exports ZDOTDIR/USER_ZDOTDIR so that every zsh
  // started under it sources the developer's real ~/.zshenv and ~/.zprofile, whose
  // `. "$HOME/.cargo/env"` lines then point at the attempt's empty HOME and fail
  // before the agent's first Bash command runs. The agent's shells must start
  // from the attempt's HOME and nothing else.
  'ZDOTDIR',
  'USER_ZDOTDIR',
  'VSCODE_ZDOTDIR',
  'BASH_ENV',
  'ENV',
  // Set by package managers that launched the harness.
  'NODE_PATH',
  'INIT_CWD',
  'npm_command',
  'npm_execpath',
  'npm_node_execpath',
])

const STRIPPED_PREFIXES = ['npm_lifecycle_', 'npm_package_', 'npm_config_', 'PNPM_']

function isWorkspaceBin(entry: string): boolean {
  return entry.includes(`${path.sep}node_modules${path.sep}.bin`) || entry.includes(`${path.sep}node_modules${path.sep}.pnpm${path.sep}`)
}

/**
 * The environment for the runner and for grading commands: the caller's
 * environment minus anything that would leak the developer's setup, with HOME
 * pointed at the attempt and package caches shared across attempts so
 * `npm ci` does not re-download the world every time.
 */
export function isolatedEnv(base: NodeJS.ProcessEnv, home: string, caches: Caches): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (STRIPPED_EXACT.has(key)) continue
    if (STRIPPED_PREFIXES.some(prefix => key.startsWith(prefix))) continue
    env[key] = value
  }
  // pnpm prepends every workspace node_modules/.bin to PATH; the evaluated
  // agent should see a normal shell, not Coro's own toolchain.
  if (env['PATH']) env['PATH'] = env['PATH'].split(path.delimiter).filter(entry => !isWorkspaceBin(entry)).join(path.delimiter)

  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    npm_config_cache: caches.npm,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    GOMODCACHE: caches.goMod,
    GOCACHE: caches.goBuild,
  }
}

// ── The workspace ────────────────────────────────────────────────────────────

export interface Workspace {
  root: string
  home: string
  configPath: string
  workingDir: string
  /** The git repository the job is pointed at (`repo` in the dispatch request). */
  sandbox: string
  /** Where grading checks out the delivered code. */
  grade: string
  /** Commit of the untouched fixture. */
  baseSha: string
}

const GITCONFIG = `[user]
\tname = Coro Eval
\temail = coro-eval@example.invalid
[init]
\tdefaultBranch = main
[safe]
\tdirectory = *
[advice]
\tdetachedHead = false
[commit]
\tgpgsign = false
`

function copyFixture(from: string, to: string): void {
  fs.cpSync(from, to, {
    recursive: true,
    filter: src => {
      const name = path.basename(src)
      return name !== '.git' && name !== 'node_modules'
    },
  })
}

export interface PrepareArgs {
  /** Per-attempt directory; created if missing. */
  root: string
  task: Task
  scenario: Scenario
  credentials: Credentials
}

/**
 * Lay out one attempt:
 *
 *   <root>/home/.coro/config.json   the runner's config (mode 0600)
 *   <root>/home/.gitconfig          identity for the commits the agent makes
 *   <root>/sandbox/                 the fixture as a git repo with one commit on `main`
 *   <root>/grade/                   filled in after the job, by grading
 */
export async function prepareWorkspace({ root, task, scenario, credentials }: PrepareArgs): Promise<Workspace> {
  fs.mkdirSync(root, { recursive: true })
  const realRoot = fs.realpathSync(root)
  const home = path.join(realRoot, 'home')
  const coroDir = path.join(home, '.coro')
  const workingDir = path.join(coroDir, 'working')
  const sandbox = path.join(realRoot, 'sandbox')
  const gradeDir = path.join(realRoot, 'grade')
  fs.mkdirSync(workingDir, { recursive: true })

  fs.writeFileSync(path.join(home, '.gitconfig'), GITCONFIG)

  copyFixture(task.repoDir, sandbox)
  await git(['init', '-b', 'main'], sandbox)
  await git(['add', '-A'], sandbox)
  await git(['commit', '-m', `Fixture: ${task.id}`], sandbox)
  const baseSha = (await git(['rev-parse', 'HEAD'], sandbox)).trim()

  const configPath = path.join(coroDir, 'config.json')
  const config = buildCoroConfig({ scenario, credentials, workingDir })
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })

  return { root: realRoot, home, configPath, workingDir, sandbox, grade: gradeDir, baseSha }
}
