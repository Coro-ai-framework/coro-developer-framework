import path from 'node:path'

export const DESKTOP_SHELL_PROTOCOL_VERSION = 1
export const DESKTOP_RUNNER_DEFAULT_HOST = '127.0.0.1'
export const DESKTOP_RUNNER_HEALTH_PATH = '/health'
export const DESKTOP_RUNNER_DASHBOARD_PATH = '/dashboard/'
export const DESKTOP_RUNNER_DEFAULT_PREFERRED_PORT = 3000

export const DESKTOP_REQUIRED_ENV = {
  noOpen: 'CORO_NO_OPEN',
  dashboardDist: 'CORO_DASHBOARD_DIST',
} as const

/** Sidecar health poll budget for unpackaged desktop dev runs. */
export const DESKTOP_RUNNER_STARTUP_TIMEOUT_MS = 15_000

/** Sidecar health poll budget for packaged desktop installs (cold boot). */
export const DESKTOP_RUNNER_PACKAGED_STARTUP_TIMEOUT_MS = 45_000

export interface DesktopRunnerLaunchOptions {
  port: number
  dashboardDist: string
  configPath?: string
  host?: string
  env?: NodeJS.ProcessEnv
}

export interface DesktopRunnerLaunchSpec {
  protocolVersion: number
  commandArgs: string[]
  env: NodeJS.ProcessEnv
  urls: {
    origin: string
    health: string
    dashboard: string
  }
}

export function buildDesktopRunnerLaunchSpec(
  options: DesktopRunnerLaunchOptions,
): DesktopRunnerLaunchSpec {
  assertValidDesktopPort(options.port)

  const host = options.host ?? DESKTOP_RUNNER_DEFAULT_HOST
  const dashboardDist = path.resolve(options.dashboardDist)
  const origin = `http://${host}:${options.port}`
  const commandArgs = ['dist/cli/index.js', 'start', '--port', String(options.port), '--no-open']
  if (options.configPath) {
    commandArgs.push('--config', options.configPath)
  }

  return {
    protocolVersion: DESKTOP_SHELL_PROTOCOL_VERSION,
    commandArgs,
    env: {
      ...options.env,
      NODE_ENV: 'production',
      [DESKTOP_REQUIRED_ENV.noOpen]: '1',
      [DESKTOP_REQUIRED_ENV.dashboardDist]: dashboardDist,
    },
    urls: {
      origin,
      health: `${origin}${DESKTOP_RUNNER_HEALTH_PATH}`,
      dashboard: `${origin}${DESKTOP_RUNNER_DASHBOARD_PATH}`,
    },
  }
}

export function assertValidDesktopPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Desktop runner port must be an integer between 1 and 65535; received ${port}`)
  }
}