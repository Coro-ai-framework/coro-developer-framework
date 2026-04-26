// ── CLI → Browser auto-open ──────────────────────────────────────────────────
//
// Helper that opens the Coro dashboard in the user's default browser once
// the runner's local HTTP server is actually accepting connections.
//
// Two reasons this isn't a one-line `child_process.exec('open …')`:
//
//   1. We have to wait until the server is listening, otherwise the browser
//      lands on `ERR_CONNECTION_REFUSED`. We poll `/health` and only open
//      after a successful 200.
//
//   2. We must not open a browser in headless contexts (CI runners, SSH
//      sessions on a server, Docker containers, Linux desktops with no
//      $DISPLAY). The `--no-open` flag lets users opt out unconditionally;
//      the heuristics below let us auto-skip in obvious headless cases.

import { spawn } from 'child_process'
import http from 'http'

interface MaybeOpenOptions {
  port: number
  /** True if the user passed `--open` explicitly; bypasses headless detection. */
  explicitlyRequested: boolean
  /** Override (mainly for tests). */
  url?: string
  /** Override (mainly for tests). */
  pollIntervalMs?: number
  /** Override (mainly for tests). */
  pollTimeoutMs?: number
}

/**
 * Heuristic: are we in an environment where opening a browser would either
 * fail silently or surprise the user?
 *
 * We bias toward "open it" — false positives waste a browser tab, false
 * negatives leave the user staring at a terminal wondering what to do.
 */
function looksHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CORO_NO_OPEN === '1' || env.CORO_NO_OPEN === 'true') return true
  if (env.CI === 'true' || env.CI === '1') return true
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return true
  // Linux desktop typically sets DISPLAY (X11) or WAYLAND_DISPLAY.
  if (process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true
  return false
}

/** OS-specific command to open a URL in the default browser. */
function openCommand(url: string): { cmd: string; args: string[] } {
  switch (process.platform) {
    case 'darwin':
      return { cmd: 'open', args: [url] }
    case 'win32':
      // `start ""` syntax via cmd /c handles URLs with `&` correctly.
      return { cmd: 'cmd', args: ['/c', 'start', '""', url] }
    default:
      // Most Linux desktops have xdg-open. If not, the user can install
      // `xdg-utils` or pass `--no-open`.
      return { cmd: 'xdg-open', args: [url] }
  }
}

/** Single GET against /health that resolves true on 200, false otherwise. */
function pingOnce(url: string): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      // Drain so the socket can be reused.
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1_000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * Wait for the runner to be ready by polling its /health endpoint.
 * Returns true if it became ready within `timeoutMs`, false on timeout.
 */
async function waitForReady(
  port: number,
  intervalMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/health`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pingOnce(url)) return true
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return false
}

/**
 * Best-effort: wait for the runner, then spawn the browser. Never throws —
 * a browser-open failure should not take down the runner.
 */
export async function maybeOpenBrowser(opts: MaybeOpenOptions): Promise<void> {
  const url = opts.url ?? `http://localhost:${opts.port}/dashboard/`

  if (!opts.explicitlyRequested && looksHeadless()) {
    // Surface why we skipped — useful in CI logs and on remote-dev boxes.
    // eslint-disable-next-line no-console
    console.log(`▸ Headless environment detected; not opening a browser. Visit ${url} manually.`)
    return
  }

  const ready = await waitForReady(
    opts.port,
    opts.pollIntervalMs ?? 200,
    opts.pollTimeoutMs ?? 15_000,
  )
  if (!ready) {
    // eslint-disable-next-line no-console
    console.log(`▸ Runner did not respond to /health within timeout; please open ${url} manually.`)
    return
  }

  const { cmd, args } = openCommand(url)
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
    child.on('error', err => {
      // eslint-disable-next-line no-console
      console.log(`▸ Could not auto-open browser (${err.message}); visit ${url} manually.`)
    })
    child.unref()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.log(`▸ Could not auto-open browser (${(err as Error).message}); visit ${url} manually.`)
  }
}

// Exported for unit tests.
export const __test = { looksHeadless, openCommand, waitForReady }
