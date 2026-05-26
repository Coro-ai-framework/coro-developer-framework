#!/usr/bin/env node
/**
 * Stage @coro-ai/runner for npm publish: bundle dashboard + internal workspace
 * packages into the tarball. LLM executors stay as normal npm dependencies.
 *
 * Output: packages/runner/.npm-publish/  (safe to delete and regenerate)
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const manifest = JSON.parse(readFileSync(path.join(__dirname, 'publish-packages.json'), 'utf8'))
const runnerSource = path.join(root, 'packages/runner')
const dashboardDist = path.join(root, 'packages/dashboard/dist')
const stagingRoot = path.join(runnerSource, '.npm-publish')

const bundled = manifest.runnerBundle
const bundledByName = new Map(bundled.map(entry => [entry.name, entry]))

rmSync(stagingRoot, { recursive: true, force: true })
mkdirSync(stagingRoot, { recursive: true })

try {
  readFileSync(path.join(dashboardDist, 'index.html'))
} catch {
  console.error('::error::Dashboard build missing. Run pnpm --filter @coro-ai/dashboard build first.')
  process.exit(1)
}

cpSync(path.join(runnerSource, 'dist'), path.join(stagingRoot, 'dist'), { recursive: true })
rmSync(path.join(stagingRoot, 'dist', 'tests'), { recursive: true, force: true })
for (const name of ['vitest.config.js', 'vitest.config.d.ts', 'vitest.config.js.map']) {
  try {
    rmSync(path.join(stagingRoot, 'dist', name))
  } catch {
    // optional
  }
}
cpSync(dashboardDist, path.join(stagingRoot, 'dashboard-dist'), { recursive: true })

const readmeSrc = path.join(runnerSource, 'README.md')
try {
  copyFileSync(readmeSrc, path.join(stagingRoot, 'README.md'))
} catch {
  // optional
}

const npmignoreSrc = path.join(runnerSource, '.npmignore')
try {
  copyFileSync(npmignoreSrc, path.join(stagingRoot, '.npmignore'))
} catch {
  // optional
}

for (const entry of bundled) {
  const sourceDir = path.join(root, entry.source)
  const stagedDir = path.join(stagingRoot, 'vendor', entry.folder)
  cpSync(path.join(sourceDir, 'dist'), path.join(stagedDir, 'dist'), { recursive: true })
  for (const extra of entry.extraFiles) {
    cpSync(path.join(sourceDir, extra), path.join(stagedDir, extra), { recursive: true })
  }
  try {
    copyFileSync(path.join(sourceDir, 'README.md'), path.join(stagedDir, 'README.md'))
  } catch {
    // optional
  }
  const pkgJson = JSON.parse(readFileSync(path.join(sourceDir, 'package.json'), 'utf8'))
  writeFileSync(
    path.join(stagedDir, 'package.json'),
    `${JSON.stringify(
      {
        name: pkgJson.name,
        version: pkgJson.version,
        description: pkgJson.description,
        type: pkgJson.type,
        main: pkgJson.main,
        types: pkgJson.types,
        files: pkgJson.files,
        exports: pkgJson.exports,
        ...(pkgJson.dependencies
          ? { dependencies: rewriteWorkspaceDeps(pkgJson.dependencies) }
          : {}),
        ...(pkgJson.peerDependencies
          ? { peerDependencies: rewriteWorkspaceDeps(pkgJson.peerDependencies) }
          : {}),
      },
      null,
      2,
    )}\n`,
  )
}

const runnerPkg = JSON.parse(readFileSync(path.join(runnerSource, 'package.json'), 'utf8'))
const version = runnerPkg.version
const npmDeps = {}

for (const [name, spec] of Object.entries(runnerPkg.dependencies ?? {})) {
  if (typeof spec === 'string' && spec.startsWith('workspace:')) {
    if (bundledByName.has(name)) {
      npmDeps[name] = `file:./vendor/${bundledByName.get(name).folder}`
      continue
    }
    if (name === '@coro-ai/dashboard') continue
    console.error(`::error::Unhandled workspace dependency for npm publish: ${name}`)
    process.exit(1)
  }
  npmDeps[name] = spec
}

writeFileSync(
  path.join(stagingRoot, 'package.json'),
  `${JSON.stringify(
    {
      name: runnerPkg.name,
      version: runnerPkg.version,
      description: runnerPkg.description,
      license: runnerPkg.license,
      engines: runnerPkg.engines,
      main: runnerPkg.main,
      bin: runnerPkg.bin,
      // Ship production node_modules in the tarball. `npm install -g` does
      // not reliably install a package's regular dependencies when only
      // `bundledDependencies` are packed (see pino/express missing after
      // global install). Local `npm install` hoists to the prefix root and
      // works; global install does not — so vendoring node_modules here is
      // the reliable fix for `coro` on PATH.
      files: ['dist', 'dashboard-dist', 'README.md', 'node_modules'],
      repository: runnerPkg.repository,
      bugs: runnerPkg.bugs,
      homepage: runnerPkg.homepage,
      publishConfig: runnerPkg.publishConfig,
      keywords: runnerPkg.keywords,
      dependencies: npmDeps,
    },
    null,
    2,
  )}\n`,
)

runNpmInstall(stagingRoot)

for (const entry of bundled) {
  materializeLocalDependency(
    path.join(stagingRoot, 'vendor', entry.folder),
    path.join(stagingRoot, 'node_modules', ...entry.name.split('/')),
  )
}

rmSync(path.join(stagingRoot, 'vendor'), { recursive: true, force: true })
try {
  rmSync(path.join(stagingRoot, 'package-lock.json'))
} catch {
  // optional
}

// Pin @coro-ai/* dependency versions in package.json metadata. Keep every
// production package in node_modules — the tarball ships that tree via
// `files` above (required for `npm install -g`).
const stagedPkgPath = path.join(stagingRoot, 'package.json')
const stagedPkg = JSON.parse(readFileSync(stagedPkgPath, 'utf8'))
const bundledNames = [
  '@coro-ai/intelligence-base',
  '@coro-ai/cloud-protocol',
  '@coro-ai/plugin-sdk',
]
for (const name of Object.keys(stagedPkg.dependencies ?? {})) {
  if (name.startsWith('@coro-ai/')) {
    stagedPkg.dependencies[name] = version
  }
}
stagedPkg.bundledDependencies = bundledNames
writeFileSync(stagedPkgPath, `${JSON.stringify(stagedPkg, null, 2)}\n`)

assertProductionNodeModules(stagingRoot)

console.log(`Prepared npm publish staging at ${stagingRoot}`)

function rewriteWorkspaceDeps(deps) {
  const out = {}
  for (const [name, spec] of Object.entries(deps ?? {})) {
    if (typeof spec === 'string' && spec.startsWith('workspace:')) {
      const vendored = bundledByName.get(name)
      if (vendored) out[name] = `file:../${vendored.folder}`
      continue
    }
    out[name] = spec
  }
  return out
}

function runNpmInstall(cwd) {
  const result = spawnSync('npm', ['install', '--omit=dev', '--package-lock=false'], {
    cwd,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function materializeLocalDependency(sourceDir, installedDir) {
  rmSync(installedDir, { recursive: true, force: true })
  mkdirSync(path.dirname(installedDir), { recursive: true })
  cpSync(sourceDir, installedDir, { recursive: true })
}

/** Fail fast if the staging tree is missing runtime deps we know global installs omit. */
function assertProductionNodeModules(stagingRoot) {
  const required = ['pino', 'express', 'commander', '@coro-ai/llm-anthropic']
  const missing = []
  for (const name of required) {
    const dir = path.join(stagingRoot, 'node_modules', ...name.split('/'))
    try {
      readFileSync(path.join(dir, 'package.json'))
    } catch {
      missing.push(name)
    }
  }
  if (missing.length) {
    console.error(`::error::Staging node_modules is missing: ${missing.join(', ')}`)
    process.exit(1)
  }
}
