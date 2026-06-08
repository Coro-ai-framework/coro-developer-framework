#!/usr/bin/env node
/**
 * Postinstall hook for @coro-ai/runner global/desktop installs.
 * The main @anthropic-ai/claude-agent-sdk package (JS) ships in the tarball;
 * the native `claude` binary lives in a platform-specific optional dependency
 * that must be resolved on the consumer's host OS at install time.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')
const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const sdkVersion = pkg.dependencies?.['@anthropic-ai/claude-agent-sdk']

if (!sdkVersion || typeof sdkVersion !== 'string') {
  console.warn(
    '[coro] @anthropic-ai/claude-agent-sdk is not declared — skipping platform CLI install',
  )
  process.exit(0)
}

const platform = process.platform
const arch = process.arch
if (
  (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') ||
  (arch !== 'x64' && arch !== 'arm64')
) {
  console.warn(`[coro] Unsupported host ${platform}/${arch} — skipping platform CLI install`)
  process.exit(0)
}

const platformPackage = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`
const binaryName = platform === 'win32' ? 'claude.exe' : 'claude'

function resolvePlatformBinaryPath() {
  const localRequire = createRequire(path.join(packageRoot, 'package.json'))
  const platformPkgJson = localRequire.resolve(`${platformPackage}/package.json`)
  return path.join(path.dirname(platformPkgJson), binaryName)
}

try {
  if (existsSync(resolvePlatformBinaryPath())) {
    process.exit(0)
  }
} catch {
  // Platform package not installed yet — install below.
}

console.log(`[coro] Installing Claude Agent SDK native binary: ${platformPackage}@${sdkVersion}`)

const result = spawnSync(
  'npm',
  ['install', `${platformPackage}@${sdkVersion}`, '--no-save', '--no-audit', '--no-fund'],
  {
    cwd: packageRoot,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  },
)

if (result.status !== 0) {
  console.error(
    `[coro] Failed to install ${platformPackage}. ` +
      'Set CLAUDE_CODE_CLI_PATH to a working claude binary or re-run npm install.',
  )
  process.exit(result.status ?? 1)
}

let binaryPath
try {
  binaryPath = resolvePlatformBinaryPath()
} catch (err) {
  console.error(
    `[coro] ${platformPackage} installed but package could not be resolved: ${(err).message}`,
  )
  process.exit(1)
}

if (!existsSync(binaryPath)) {
  console.error(`[coro] ${platformPackage} installed but ${binaryName} is missing at ${binaryPath}`)
  process.exit(1)
}

console.log(`[coro] Claude Agent SDK native binary ready: ${binaryPath}`)
