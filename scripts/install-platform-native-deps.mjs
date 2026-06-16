#!/usr/bin/env node
/**
 * Postinstall hook for @coro-ai/runner global installs.
 *
 * The publish tarball is built on Linux CI and bundles JS dependencies, but
 * platform-specific native artifacts must be resolved on the consumer host:
 *
 *   - @anthropic-ai/claude-agent-sdk-<os>-<arch>  (Claude CLI binary)
 *   - better-sqlite3/build/Release/*.node          (local SQLite backend)
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')
const pkg = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))

// Apply before any native-addon install/rebuild subprocess (better-sqlite3 install
// can run before this postinstall on global installs). .npmrc in the published
// package also sets msvs_version=2022; this covers environments that skip it.
if (process.platform === 'win32' && !process.env.npm_config_msvs_version) {
  process.env.npm_config_msvs_version = '2022'
}

installClaudeSdkPlatformBinary(pkg)
rebuildBetterSqlite3(pkg)

function installClaudeSdkPlatformBinary(pkg) {
  const sdkVersion = pkg.dependencies?.['@anthropic-ai/claude-agent-sdk']
  if (!sdkVersion || typeof sdkVersion !== 'string') {
    console.warn(
      '[coro] @anthropic-ai/claude-agent-sdk is not declared — skipping platform CLI install',
    )
    return
  }

  const platform = process.platform
  const arch = process.arch
  if (
    (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') ||
    (arch !== 'x64' && arch !== 'arm64')
  ) {
    console.warn(`[coro] Unsupported host ${platform}/${arch} — skipping platform CLI install`)
    return
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
      console.log(`[coro] Claude Agent SDK native binary already present`)
      return
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
      `[coro] ${platformPackage} installed but package could not be resolved: ${err.message}`,
    )
    process.exit(1)
  }

  if (!existsSync(binaryPath)) {
    console.error(`[coro] ${platformPackage} installed but ${binaryName} is missing at ${binaryPath}`)
    process.exit(1)
  }

  console.log(`[coro] Claude Agent SDK native binary ready: ${binaryPath}`)
}

function rebuildBetterSqlite3(pkg) {
  const spec = pkg.dependencies?.['better-sqlite3']
  if (!spec || typeof spec !== 'string') {
    console.warn('[coro] better-sqlite3 is not declared — skipping native rebuild')
    return
  }

  if (betterSqlite3Works()) {
    console.log('[coro] better-sqlite3 native binding already works on this host')
    return
  }

  console.log(
    `[coro] Rebuilding better-sqlite3 for ${process.platform}/${process.arch} ` +
      '(publish tarball strips cross-platform native artifacts)',
  )

  const rebuildEnv = { ...process.env }
  if (process.platform === 'win32' && !rebuildEnv.npm_config_msvs_version) {
    // node-gyp on Windows may fail to auto-detect Visual Studio via PowerShell.
    // Explicitly targeting VS 2022 bypasses the detection and lets compilation succeed.
    // An existing npm_config_msvs_version is respected so users can override if needed.
    rebuildEnv.npm_config_msvs_version = '2022'
  }

  const result = spawnSync('npm', ['rebuild', 'better-sqlite3', '--no-audit', '--no-fund'], {
    cwd: packageRoot,
    stdio: 'inherit',
    env: rebuildEnv,
    shell: process.platform === 'win32',
  })

  if (result.status !== 0) {
    console.error(
      '[coro] Failed to rebuild better-sqlite3. ' +
        'Ensure Node.js build tools are available (Windows: VS Build Tools) and re-run npm install.',
    )
    process.exit(result.status ?? 1)
  }

  if (!betterSqlite3Works()) {
    console.error('[coro] better-sqlite3 rebuild completed but :memory: open still fails')
    process.exit(1)
  }

  console.log('[coro] better-sqlite3 native binding ready')
}

function betterSqlite3Works() {
  try {
    const localRequire = createRequire(path.join(packageRoot, 'package.json'))
    const Database = localRequire('better-sqlite3')
    const db = new Database(':memory:')
    db.prepare('select 1 as ok').get()
    db.close()
    return true
  } catch {
    return false
  }
}
