#!/usr/bin/env node
/**
 * Stage @coro-ai/runner for npm publish: bundle dashboard + internal workspace
 * packages into the tarball. LLM executors stay as normal npm dependencies.
 *
 * Output: packages/runner/.npm-publish/  (safe to delete and regenerate)
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
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
/** Resolved at install time on the consumer's OS — must not be bundled (platform-specific optional deps). */
const CLAUDE_SDK_PKG = '@anthropic-ai/claude-agent-sdk'
/** Native addons rebuilt by postinstall on the consumer host (tarball strips build/ artifacts). */
const NATIVE_REBUILD_PACKAGES = ['better-sqlite3']

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
// production package in node_modules — the tarball must ship that tree for
// `npm install -g` (global installs do not hoist sibling deps like local
// installs do).
//
// npm ignores `node_modules` in `files` unless dependencies are bundled.
// A partial `bundledDependencies` list only packs those packages and their
// transitive tree — direct deps like pino/express are omitted. Bundle all
// production dependencies EXCEPT the Claude Agent SDK, which ships a
// platform-specific optional binary that must be resolved on the consumer's
// host OS (npm cannot cross-install win32/darwin/linux variants in one tarball).
const stagedPkgPath = path.join(stagingRoot, 'package.json')
const stagedPkg = JSON.parse(readFileSync(stagedPkgPath, 'utf8'))

const claudeSdkVersion = readResolvedClaudeSdkVersion(stagingRoot)
removeClaudeSdkPlatformPackages(path.join(stagingRoot, 'node_modules'))
stripNativeBuildArtifacts(path.join(stagingRoot, 'node_modules'))

mkdirSync(path.join(stagingRoot, 'scripts'), { recursive: true })
copyFileSync(
  path.join(root, 'scripts', 'install-platform-native-deps.mjs'),
  path.join(stagingRoot, 'scripts', 'install-platform-native-deps.mjs'),
)

for (const name of Object.keys(stagedPkg.dependencies ?? {})) {
  if (name.startsWith('@coro-ai/')) {
    stagedPkg.dependencies[name] = version
  }
}
stagedPkg.dependencies[CLAUDE_SDK_PKG] = claudeSdkVersion
stagedPkg.scripts = {
  ...(stagedPkg.scripts ?? {}),
  postinstall: 'node scripts/install-platform-native-deps.mjs',
}
stagedPkg.files = ['dist', 'dashboard-dist', 'README.md', 'scripts', 'node_modules']
stagedPkg.bundleDependencies = enumerateBundledDependencies(stagingRoot)
writeFileSync(stagedPkgPath, `${JSON.stringify(stagedPkg, null, 2)}\n`)

assertProductionNodeModules(stagingRoot, stagedPkg)

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

function readResolvedClaudeSdkVersion(stagingRoot) {
  const pkgJsonPath = path.join(
    stagingRoot,
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk',
    'package.json',
  )
  try {
    return JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version
  } catch {
    console.error(
      `::error::Could not read resolved ${CLAUDE_SDK_PKG} version from staging node_modules. ` +
        'Ensure @coro-ai/llm-anthropic is built and npm install succeeded.',
    )
    process.exit(1)
  }
}

/** Remove platform-specific optional SDK packages; keep the main JS SDK package. */
function removeClaudeSdkPlatformPackages(nodeModulesRoot) {
  if (!existsSync(nodeModulesRoot)) return

  const anthropicScope = path.join(nodeModulesRoot, '@anthropic-ai')
  if (existsSync(anthropicScope)) {
    for (const entry of readdirSync(anthropicScope, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('claude-agent-sdk-')) {
        rmSync(path.join(anthropicScope, entry.name), { recursive: true, force: true })
      }
    }
  }

  for (const entry of readdirSync(nodeModulesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin' || entry.name === '@anthropic-ai') continue

    if (entry.name.startsWith('@')) {
      const scopePath = path.join(nodeModulesRoot, entry.name)
      for (const pkg of readdirSync(scopePath, { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue
        const nested = path.join(scopePath, pkg.name, 'node_modules')
        if (existsSync(nested)) removeClaudeSdkPlatformPackages(nested)
      }
      continue
    }

    const nested = path.join(nodeModulesRoot, entry.name, 'node_modules')
    if (existsSync(nested)) removeClaudeSdkPlatformPackages(nested)
  }
}

/** Top-level node_modules package names to ship in the tarball (SDK excluded). */
function enumerateBundledDependencies(stagingRoot) {
  const nodeModules = path.join(stagingRoot, 'node_modules')
  const names = []
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue
    if (entry.name.startsWith('@')) {
      const scopePath = path.join(nodeModules, entry.name)
      for (const pkg of readdirSync(scopePath, { withFileTypes: true })) {
        if (pkg.isDirectory()) {
          const fullName = `${entry.name}/${pkg.name}`
          if (fullName !== CLAUDE_SDK_PKG) names.push(fullName)
        }
      }
      continue
    }
    names.push(entry.name)
  }
  return names.sort()
}

/** Remove compiled native artifacts so postinstall rebuilds for the consumer OS. */
function stripNativeBuildArtifacts(nodeModulesRoot) {
  if (!existsSync(nodeModulesRoot)) return

  for (const pkgName of NATIVE_REBUILD_PACKAGES) {
    const pkgDir = path.join(nodeModulesRoot, ...pkgName.split('/'))
    const buildDir = path.join(pkgDir, 'build')
    if (existsSync(buildDir)) {
      rmSync(buildDir, { recursive: true, force: true })
    }
    // Also remove prebuilt binaries compiled on the build host (e.g. Linux CI).
    // prebuild-install will download or compile the correct binary for the
    // consumer OS instead of attempting to load an incompatible pre-built artifact.
    const prebuildsDir = path.join(pkgDir, 'prebuilds')
    if (existsSync(prebuildsDir)) {
      rmSync(prebuildsDir, { recursive: true, force: true })
    }
  }

  for (const entry of readdirSync(nodeModulesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue

    if (entry.name.startsWith('@')) {
      const scopePath = path.join(nodeModulesRoot, entry.name)
      for (const pkg of readdirSync(scopePath, { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue
        const nested = path.join(scopePath, pkg.name, 'node_modules')
        if (existsSync(nested)) stripNativeBuildArtifacts(nested)
      }
      continue
    }

    const nested = path.join(nodeModulesRoot, entry.name, 'node_modules')
    if (existsSync(nested)) stripNativeBuildArtifacts(nested)
  }
}

function nativeBuildArtifactsPresent(stagingRoot) {
  for (const pkgName of NATIVE_REBUILD_PACKAGES) {
    const pkgNodeModules = path.join(stagingRoot, 'node_modules', ...pkgName.split('/'))
    if (existsSync(path.join(pkgNodeModules, 'build'))) return `${pkgName}/build`
    if (existsSync(path.join(pkgNodeModules, 'prebuilds'))) return `${pkgName}/prebuilds`
  }
  return null
}

function claudeSdkPlatformPackagesPresent(stagingRoot) {
  const anthropicScope = path.join(stagingRoot, 'node_modules', '@anthropic-ai')
  if (!existsSync(anthropicScope)) return false
  return readdirSync(anthropicScope, { withFileTypes: true }).some(
    entry => entry.isDirectory() && entry.name.startsWith('claude-agent-sdk-'),
  )
}

/** Fail fast if the staging tree is missing runtime deps we know global installs omit. */
function assertProductionNodeModules(stagingRoot, stagedPkg) {
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

  if (!stagedPkg.dependencies?.[CLAUDE_SDK_PKG]) {
    console.error(`::error::${CLAUDE_SDK_PKG} must be listed in staged dependencies for consumer install`)
    process.exit(1)
  }

  const sdkMainDir = path.join(stagingRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
  try {
    readFileSync(path.join(sdkMainDir, 'package.json'))
  } catch {
    console.error(`::error::${CLAUDE_SDK_PKG} main JS package must remain in staged node_modules`)
    process.exit(1)
  }

  if (claudeSdkPlatformPackagesPresent(stagingRoot)) {
    console.error(
      `::error::Platform-specific claude-agent-sdk-* packages must be absent from staged node_modules (postinstall fetches them)`,
    )
    process.exit(1)
  }

  const leftoverNative = nativeBuildArtifactsPresent(stagingRoot)
  if (leftoverNative) {
    console.error(
      `::error::${leftoverNative} must be absent from staged node_modules (postinstall rebuilds native addons)`,
    )
    process.exit(1)
  }

  const postinstallScript = path.join(stagingRoot, 'scripts', 'install-platform-native-deps.mjs')
  if (!existsSync(postinstallScript)) {
    console.error('::error::Missing scripts/install-platform-native-deps.mjs in staging tree')
    process.exit(1)
  }
}
