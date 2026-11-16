// ── GitHub CLI session helpers ───────────────────────────────────────────────
//
// Shared by credential detection and browser sign-in (gh auth login --web).
//
// `gh` supports several signed-in accounts per host, and every helper here is
// account-aware for that reason: a user with a personal and a work login must
// be able to see both and pick, rather than silently getting whichever one
// `gh` currently considers active.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const GH_TIMEOUT_MS = 3_000
const GH_LOGIN_TIMEOUT_MS = 5 * 60_000

export interface GhAccount {
  login: string
  /** The account `gh` uses when no `--user` is passed. */
  active: boolean
}

export async function ghCommandExists(): Promise<boolean> {
  try {
    await execFileAsync('gh', ['--version'], { timeout: GH_TIMEOUT_MS, encoding: 'utf-8' })
    return true
  } catch {
    return false
  }
}

/**
 * Every account `gh` is signed in to on github.com, active one flagged.
 *
 * Parsed from `gh auth status`, which prints a block per account:
 *
 *     github.com
 *       ✓ Logged in to github.com account octocat (keyring)
 *       - Active account: true
 *
 * `gh` has moved this output between stdout and stderr across versions, so
 * both are parsed. Returns an empty list rather than throwing when `gh` is
 * absent or signed out — callers treat detection as best-effort.
 */
export async function listGhAccounts(): Promise<GhAccount[]> {
  let output = ''
  try {
    const { stdout, stderr } = await execFileAsync(
      'gh',
      ['auth', 'status', '--hostname', 'github.com'],
      { timeout: GH_TIMEOUT_MS, encoding: 'utf-8' },
    )
    output = `${stdout}\n${stderr}`
  } catch (err) {
    // A signed-out `gh` exits non-zero but still prints usable output.
    const e = err as { stdout?: string; stderr?: string }
    output = `${e?.stdout ?? ''}\n${e?.stderr ?? ''}`
  }
  if (!output.trim()) return []

  const accounts: GhAccount[] = []
  const lines = output.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]?.match(/Logged in to \S+ account (\S+)/)
    if (!match?.[1]) continue
    const login = match[1]
    if (accounts.some(a => a.login === login)) continue
    // "Active account: true" belongs to the block that just started, i.e.
    // before the next "Logged in to" line.
    let active = false
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j] ?? ''
      if (/Logged in to \S+ account /.test(line)) break
      if (/Active account:\s*true/i.test(line)) {
        active = true
        break
      }
    }
    accounts.push({ login, active })
  }
  // Older `gh` builds omit the "Active account" line entirely because they
  // only support one account; treat a lone account as active.
  if (accounts.length === 1 && accounts[0] && !accounts[0].active) {
    accounts[0].active = true
  }
  return accounts
}

/**
 * Read a token from `gh`. Pass `login` to target a specific account; omit it
 * for whichever account is active. Returns null when `gh` is missing, signed
 * out, or too old to understand `--user`.
 */
export async function tryGhAuthToken(login?: string): Promise<string | null> {
  const args = ['auth', 'token', '--hostname', 'github.com']
  if (login) args.push('--user', login)
  try {
    const { stdout } = await execFileAsync('gh', args, {
      timeout: GH_TIMEOUT_MS,
      encoding: 'utf-8',
    })
    const token = stdout.trim()
    return token.length > 0 ? token : null
  } catch {
    return null
  }
}

export async function validateGithubToken(
  fetchFn: typeof fetch,
  token: string,
  apiBaseUrl?: string,
): Promise<{ login: string } | null> {
  try {
    const base = (apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '')
    const res = await fetchFn(`${base}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'coro-runner',
      },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { login?: string }
    if (typeof body.login !== 'string' || !body.login) return null
    return { login: body.login }
  } catch {
    return null
  }
}

/** What the user needs to finish a device-flow sign-in in their browser. */
export interface GhDevicePrompt {
  userCode: string
  verificationUri: string
}

export interface GhWebLogin {
  /**
   * Resolves once `gh` has printed the one-time code, or null if it exits
   * first. Never rejects.
   */
  prompt: Promise<GhDevicePrompt | null>
  done: Promise<void>
  /** Terminate the `gh` process. Safe to call after it has already exited. */
  cancel: () => void
}

const DEFAULT_DEVICE_URL = 'https://github.com/login/device'
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g

/**
 * Pull the one-time code and verification URL out of `gh auth login --web`
 * output. Without a terminal `gh` never opens a browser itself; it only
 * prints these two lines, e.g.:
 *
 *     ! One-time code (ABCD-1234) copied to clipboard
 *     Open this URL to continue in your web browser: https://github.com/login/device
 *
 * Older builds print "First copy your one-time code: ABCD-1234" instead.
 */
export function parseGhDevicePrompt(output: string): GhDevicePrompt | null {
  const text = output.replace(ANSI_ESCAPE, '')
  const userCode = text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/)?.[1]
  if (!userCode) return null
  const verificationUri = text.match(/https?:\/\/[^\s"'<>]+\/login\/device/)?.[0]
  return { userCode, verificationUri: verificationUri ?? DEFAULT_DEVICE_URL }
}

/** Last non-empty line of `gh` output that isn't the prompt itself, for error messages. */
function lastLine(output: string): string {
  const lines = output
    .replace(ANSI_ESCAPE, '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/one-time code|\/login\/device/i.test(l))
  return lines[lines.length - 1] ?? ''
}

/**
 * Start `gh auth login --web` and wait for the user to finish in the browser.
 *
 * `gh` runs without a terminal here, so it neither opens the browser nor
 * shows the one-time code anywhere the user can see; `prompt` hands both to
 * the caller, whose job it is to put them in front of the user.
 *
 * Returns a cancel handle rather than a bare promise: a promise race cannot
 * stop a child process, so timing out without this leaves `gh` running
 * indefinitely, holding a terminal-less prompt nobody can answer.
 */
export function runGhWebLogin(): GhWebLogin {
  let child: ChildProcess | null = null
  let settled = false
  let output = ''
  let resolvePrompt: (prompt: GhDevicePrompt | null) => void = () => {}
  const prompt = new Promise<GhDevicePrompt | null>(resolve => {
    resolvePrompt = resolve
  })

  const done = new Promise<void>((resolve, reject) => {
    child = spawn(
      'gh',
      [
        'auth',
        'login',
        '--hostname',
        'github.com',
        '--git-protocol',
        'https',
        '--web',
        '--scopes',
        'repo,read:user',
      ],
      {
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    const onOutput = (chunk: Buffer | string) => {
      // The prompt arrives in the first few lines; cap what we keep so a
      // chatty `gh` cannot grow this for the full five-minute window.
      if (output.length < 16_384) output += chunk.toString()
      const parsed = parseGhDevicePrompt(output)
      if (parsed) resolvePrompt(parsed)
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)
    child.on('error', err => {
      settled = true
      resolvePrompt(null)
      reject(err)
    })
    child.on('exit', code => {
      settled = true
      resolvePrompt(null)
      if (code === 0) {
        resolve()
        return
      }
      const detail = lastLine(output)
      reject(new Error(
        `GitHub CLI sign-in did not complete (exit ${code ?? 'unknown'})${detail ? `: ${detail}` : '.'}`,
      ))
    })
  })

  return {
    prompt,
    done,
    cancel: () => {
      if (settled || !child) return
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    },
  }
}

/**
 * Start a browser sign-in bounded by `timeoutMs`. `prompt` is available as
 * soon as `gh` prints it; `done` settles when the user finishes, `gh`
 * fails, or the timeout kills it.
 */
export function startGhWebLogin(timeoutMs = GH_LOGIN_TIMEOUT_MS): GhWebLogin {
  const login = runGhWebLogin()
  let timer: NodeJS.Timeout | undefined
  const done = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => {
      login.cancel()
      reject(new Error('GitHub sign-in timed out. Try again.'))
    }, timeoutMs)
    login.done.then(resolve, reject)
  }).finally(() => {
    if (timer) clearTimeout(timer)
  })
  // Nothing is waiting on the inner `done` after a timeout; swallow its
  // rejection so the kill doesn't surface as an unhandled rejection.
  login.done.catch(() => {})
  return { prompt: login.prompt, done, cancel: login.cancel }
}
