#!/usr/bin/env node
/**
 * Cross-platform smoke test: pack the staged @coro-ai/runner tarball, global-install
 * it into a temp prefix, and assert resolveClaudeCodeCliPath() finds the native
 * Claude binary for the host OS.
 *
 * Expects packages/runner/.npm-publish/ to exist (run prepare-runner-npm-publish.mjs first).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const stagingDir = path.join(root, 'packages/runner/.npm-publish')

if (!existsSync(path.join(stagingDir, 'package.json'))) {
  console.error(
    `::error::Missing ${stagingDir}. Run node scripts/prepare-runner-npm-publish.mjs first.`,
  )
  process.exit(1)
}

const packDir = mkdtempSync(path.join(tmpdir(), 'coro-runner-pack-'))
const prefix = mkdtempSync(path.join(tmpdir(), 'coro-runner-prefix-'))

try {
  const pack = spawnSync('npm', ['pack', '--pack-destination', packDir], {
    cwd: stagingDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (pack.status !== 0) {
    console.error('::error::npm pack failed')
    process.exit(pack.status ?? 1)
  }

  const tarball = readdirSync(packDir).find(name => name.endsWith('.tgz'))
  if (!tarball) {
    console.error('::error::npm pack produced no .tgz in', packDir)
    process.exit(1)
  }

  const install = spawnSync(
    'npm',
    ['install', '-g', path.join(packDir, tarball), '--prefix', prefix, '--no-audit', '--no-fund'],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  )
  if (install.status !== 0) {
    console.error('::error::npm install -g failed')
    process.exit(install.status ?? 1)
  }

  const modulesRoot = resolveGlobalModulesRoot(prefix)
  const runnerDir = path.join(modulesRoot, '@coro-ai', 'runner')
  const llmAnthropicDir = path.join(runnerDir, 'node_modules', '@coro-ai', 'llm-anthropic')
  const llmAnthropicEntry = path.join(llmAnthropicDir, 'dist', 'cli-path.js')

  if (!existsSync(llmAnthropicEntry)) {
    console.error(`::error::Installed llm-anthropic entry missing: ${llmAnthropicEntry}`)
    process.exit(1)
  }

  const verify = spawnSync(
    process.execPath,
    [
      '-e',
      `
        const { resolveClaudeCodeCliPath } = require(${JSON.stringify(llmAnthropicEntry)});
        const fs = require('node:fs');
        const cliPath = resolveClaudeCodeCliPath();
        if (!fs.existsSync(cliPath)) {
          console.error('resolveClaudeCodeCliPath returned missing file:', cliPath);
          process.exit(1);
        }
        console.log('resolveClaudeCodeCliPath OK:', cliPath);
      `,
    ],
    { encoding: 'utf8', cwd: runnerDir },
  )

  if (verify.status !== 0) {
    process.stderr.write(verify.stderr ?? '')
    console.error('::error::resolveClaudeCodeCliPath verification failed')
    process.exit(verify.status ?? 1)
  }

  process.stdout.write(verify.stdout ?? '')

  const sqliteVerify = spawnSync(
    process.execPath,
    [
      '-e',
      `
        const Database = require('better-sqlite3');
        const db = new Database(':memory:');
        const row = db.prepare('select 1 as ok').get();
        db.close();
        if (!row || row.ok !== 1) {
          console.error('better-sqlite3 :memory: probe failed');
          process.exit(1);
        }
        console.log('better-sqlite3 OK');
      `,
    ],
    { encoding: 'utf8', cwd: runnerDir },
  )

  if (sqliteVerify.status !== 0) {
    process.stderr.write(sqliteVerify.stderr ?? '')
    console.error('::error::better-sqlite3 verification failed after global install')
    process.exit(sqliteVerify.status ?? 1)
  }

  process.stdout.write(sqliteVerify.stdout ?? '')
  console.log(
    `Global install native deps verification passed on ${process.platform}/${process.arch}`,
  )
} finally {
  rmSync(packDir, { recursive: true, force: true })
  rmSync(prefix, { recursive: true, force: true })
}

function resolveGlobalModulesRoot(prefix) {
  const candidates = [
    path.join(prefix, 'node_modules'),
    path.join(prefix, 'lib', 'node_modules'),
  ]
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, '@coro-ai', 'runner', 'package.json'))) {
      return candidate
    }
  }
  throw new Error(`@coro-ai/runner not found under global prefix ${prefix}`)
}
