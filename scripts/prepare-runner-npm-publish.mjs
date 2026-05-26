#!/usr/bin/env node
/**
 * Stage @coro/runner for npm publish: bundle dashboard + internal workspace
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
  console.error('::error::Dashboard build missing. Run pnpm --filter @coro/dashboard build first.')
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
    if (name === '@coro/dashboard') continue
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
      files: ['dist', 'dashboard-dist', 'README.md'],
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

// Published tarball: LLM executors are normal npm deps; internals ship via bundledDependencies.
const stagedPkgPath = path.join(stagingRoot, 'package.json')
const stagedPkg = JSON.parse(readFileSync(stagedPkgPath, 'utf8'))
const bundledNames = [
  '@coro/intelligence-base',
  '@coro/cloud-protocol',
  '@coro/plugin-sdk',
]
for (const name of Object.keys(stagedPkg.dependencies ?? {})) {
  if (name.startsWith('@coro/llm-')) {
    stagedPkg.dependencies[name] = version
    rmSync(path.join(stagingRoot, 'node_modules', ...name.split('/')), { recursive: true, force: true })
    continue
  }
  if (bundledNames.includes(name)) {
    stagedPkg.dependencies[name] = version
  }
}
stagedPkg.bundledDependencies = bundledNames
writeFileSync(stagedPkgPath, `${JSON.stringify(stagedPkg, null, 2)}\n`)

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
