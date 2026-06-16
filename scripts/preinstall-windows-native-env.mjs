#!/usr/bin/env node
/**
 * Preinstall hook for @coro-ai/runner npm publishes.
 *
 * npm excludes .npmrc from packed tarballs, but node-gyp reads msvs_version
 * during better-sqlite3's install/rebuild (which can run before postinstall on
 * global installs). Write a local .npmrc before those scripts run on Windows.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const npmrcPath = path.join(packageRoot, '.npmrc')
  const setting = 'msvs_version=2022'

  if (!process.env.npm_config_msvs_version) {
    process.env.npm_config_msvs_version = '2022'
  }

  if (existsSync(npmrcPath)) {
    const content = readFileSync(npmrcPath, 'utf8')
    if (!content.includes('msvs_version')) {
      writeFileSync(npmrcPath, `${content.trimEnd()}\n${setting}\n`)
    }
  } else {
    writeFileSync(npmrcPath, `${setting}\n`)
  }
}
