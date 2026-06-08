import { createRequire } from 'node:module'
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const packageRoot = path.resolve(__dirname, '..')
const workspaceRoot = path.resolve(packageRoot, '../..')
const distRoot = path.join(packageRoot, 'dist')
const resourcesRoot = path.join(distRoot, 'resources')
const appResourcesRoot = path.join(resourcesRoot, 'coro')
const stagingRoot = path.join(os.tmpdir(), `coro-desktop-staging-${process.pid}`)
const runnerDeployDir = path.join(stagingRoot, 'runner')
const runnerTargetDir = path.join(appResourcesRoot, 'runner')
const dashboardTargetDir = path.join(appResourcesRoot, 'dashboard', 'dist')
const runnerSourceDir = path.join(workspaceRoot, 'packages', 'runner')
const dashboardSourceDir = path.join(workspaceRoot, 'packages', 'dashboard', 'dist')
const intelligenceSourceDir = path.join(workspaceRoot, 'packages', 'intelligence-base')

// Workspace packages the runner depends on at runtime. Each one is
// vendored into the staged runner bundle as `vendor/<name>/` and the
// runner's package.json is rewritten to point at `file:./vendor/<name>`
// so plain `npm install` (which doesn't understand `workspace:*`)
// succeeds. The `extraFiles` list captures non-`dist` assets we want
// to ship (e.g. `intelligence-base/layer/` is the canonical generic
// intelligence tree the runner reads at startup).
const VENDORED_WORKSPACE_PACKAGES = [
  {
    name: '@coro-ai/cloud-protocol',
    folder: 'cloud-protocol',
    sourceDir: path.join(workspaceRoot, 'packages', 'cloud-protocol'),
    extraFiles: [],
  },
  {
    name: '@coro-ai/intelligence-base',
    folder: 'intelligence-base',
    sourceDir: path.join(workspaceRoot, 'packages', 'intelligence-base'),
    extraFiles: ['layer'],
  },
  {
    name: '@coro-ai/plugin-sdk',
    folder: 'plugin-sdk',
    sourceDir: path.join(workspaceRoot, 'packages', 'plugin-sdk'),
    extraFiles: [],
  },
  {
    name: '@coro-ai/llm-anthropic',
    folder: 'llm-anthropic',
    sourceDir: path.join(workspaceRoot, 'packages', 'llm-anthropic'),
    extraFiles: [],
  },
  {
    name: '@coro-ai/llm-openai',
    folder: 'llm-openai',
    sourceDir: path.join(workspaceRoot, 'packages', 'llm-openai'),
    extraFiles: [],
  },
]

const VENDORED_BY_NAME = new Map(VENDORED_WORKSPACE_PACKAGES.map(pkg => [pkg.name, pkg]))

runPnpm(['--filter', '@coro-ai/cloud-protocol', 'build'])
runPnpm(['--filter', '@coro-ai/intelligence-base', 'build'])
runPnpm(['--filter', '@coro-ai/plugin-sdk', 'build'])
runPnpm(['--filter', '@coro-ai/llm-anthropic', 'build'])
runPnpm(['--filter', '@coro-ai/llm-openai', 'build'])
runPnpm(['--filter', '@coro-ai/runner', 'build'])
runPnpm(['--filter', '@coro-ai/dashboard', 'build'])

rmSync(resourcesRoot, { recursive: true, force: true })
rmSync(stagingRoot, { recursive: true, force: true })
mkdirSync(resourcesRoot, { recursive: true })

prepareRunnerBundle(runnerDeployDir)
cpSync(runnerDeployDir, runnerTargetDir, { recursive: true })
cpSync(dashboardSourceDir, dashboardTargetDir, { recursive: true })

rmSync(stagingRoot, { recursive: true, force: true })

console.log(`desktop-electron: prepared packaged resources under ${resourcesRoot}`)

function runPnpm(args) {
  runCommand('pnpm', ['--dir', workspaceRoot, ...args])
}

function prepareRunnerBundle(runnerRoot) {
  mkdirSync(runnerRoot, { recursive: true })

  cpSync(path.join(runnerSourceDir, 'dist'), path.join(runnerRoot, 'dist'), { recursive: true })

  // Stage every workspace dep into `vendor/<folder>/` with a flattened
  // package.json that drops `workspace:*` references and other tooling
  // metadata npm doesn't need at runtime.
  for (const pkg of VENDORED_WORKSPACE_PACKAGES) {
    const stagedDir = path.join(runnerRoot, 'vendor', pkg.folder)
    cpSync(path.join(pkg.sourceDir, 'dist'), path.join(stagedDir, 'dist'), { recursive: true })
    for (const extra of pkg.extraFiles) {
      const src = path.join(pkg.sourceDir, extra)
      try {
        cpSync(src, path.join(stagedDir, extra), { recursive: true })
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
      }
    }
    const readmeSrc = path.join(pkg.sourceDir, 'README.md')
    try {
      copyFileSync(readmeSrc, path.join(stagedDir, 'README.md'))
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    const pkgJson = JSON.parse(readFileSync(path.join(pkg.sourceDir, 'package.json'), 'utf8'))
    writeFileSync(
      path.join(stagedDir, 'package.json'),
      JSON.stringify(
        {
          name: pkgJson.name,
          version: pkgJson.version,
          description: pkgJson.description,
          private: true,
          type: pkgJson.type,
          main: pkgJson.main,
          types: pkgJson.types,
          files: pkgJson.files,
          exports: pkgJson.exports,
          // Keep runtime deps so `npm install` of the runner bundle
          // pulls them transitively. Strip workspace-only fields.
          ...(pkgJson.dependencies ? { dependencies: rewriteVendoredPackageDeps(pkgJson.dependencies) } : {}),
          ...(pkgJson.peerDependencies ? { peerDependencies: rewriteVendoredPackageDeps(pkgJson.peerDependencies) } : {}),
        },
        null,
        2,
      ) + '\n',
    )
  }

  const runnerPackage = JSON.parse(readFileSync(path.join(runnerSourceDir, 'package.json'), 'utf8'))

  // Rewrite each `workspace:*` runner dep to a `file:./vendor/<folder>`
  // pointer so `npm install` resolves it from the staged tree.
  const rewrittenRunnerDeps = { ...runnerPackage.dependencies }
  for (const pkg of VENDORED_WORKSPACE_PACKAGES) {
    if (rewrittenRunnerDeps[pkg.name] !== undefined) {
      rewrittenRunnerDeps[pkg.name] = `file:./vendor/${pkg.folder}`
    }
  }

  writeFileSync(
    path.join(runnerRoot, 'package.json'),
    JSON.stringify(
      {
        name: runnerPackage.name,
        version: runnerPackage.version,
        private: true,
        description: runnerPackage.description,
        main: runnerPackage.main,
        bin: runnerPackage.bin,
        engines: runnerPackage.engines,
        dependencies: rewrittenRunnerDeps,
      },
      null,
      2,
    ) + '\n',
  )

  runNpmInstall(runnerRoot)

  // npm with `file:` deps installs a symlink-or-copy of the vendored
  // tree into `node_modules`. To keep the packaged app fully self-
  // contained (no symlinks to a tmp staging path that won't exist on
  // the user's machine) we replace each install with a real copy.
  for (const pkg of VENDORED_WORKSPACE_PACKAGES) {
    const stagedDir = path.join(runnerRoot, 'vendor', pkg.folder)
    const installedDir = path.join(runnerRoot, 'node_modules', ...pkg.name.split('/'))
    materializeLocalDependency(stagedDir, installedDir)
  }

  rmSync(path.join(runnerRoot, 'node_modules', '.bin'), { recursive: true, force: true })
  rmSync(path.join(runnerRoot, 'vendor'), { recursive: true, force: true })
  rmSync(path.join(runnerRoot, 'package-lock.json'), { recursive: true, force: true })

  assertClaudeSdkPlatformBinary(runnerRoot)
  assertBetterSqlite3Binding(runnerRoot)
}

function assertBetterSqlite3Binding(runnerRoot) {
  try {
    const localRequire = createRequire(path.join(runnerRoot, 'package.json'))
    const Database = localRequire('better-sqlite3')
    const db = new Database(':memory:')
    db.prepare('select 1 as ok').get()
    db.close()
  } catch (err) {
    console.error(
      `::error::Desktop runner bundle cannot open better-sqlite3 :memory: on ${process.platform}/${process.arch}. ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        'Rebuild the runner bundle on a native host for this platform.',
    )
    process.exit(1)
  }

  console.log(`desktop-electron: verified better-sqlite3 native binding in runner bundle`)
}

function assertClaudeSdkPlatformBinary(runnerRoot) {
  const platform = process.platform
  const arch = process.arch
  if (
    (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') ||
    (arch !== 'x64' && arch !== 'arm64')
  ) {
    console.warn(
      `desktop-electron: skipping Claude SDK platform binary check on unsupported host ${platform}/${arch}`,
    )
    return
  }

  const platformFolder = `claude-agent-sdk-${platform}-${arch}`
  const binaryName = platform === 'win32' ? 'claude.exe' : 'claude'
  const binaryPath = path.join(
    runnerRoot,
    'node_modules',
    '@anthropic-ai',
    platformFolder,
    binaryName,
  )

  try {
    readFileSync(binaryPath)
  } catch {
    console.error(
      `::error::Desktop runner bundle is missing Claude Agent SDK binary for ${platform}/${arch}. ` +
        `Expected: ${binaryPath}. Re-run prepare-resources on a native ${platform} build host.`,
    )
    process.exit(1)
  }

  console.log(`desktop-electron: verified Claude SDK platform binary at ${binaryPath}`)
}

/**
 * When staging a vendored workspace package, rewrite `workspace:*` deps that
 * point at other vendored packages to `file:../<folder>` so `npm install`
 * in the runner bundle resolves them. Unknown workspace refs are dropped.
 */
function rewriteVendoredPackageDeps(deps) {
  const out = {}
  for (const [name, spec] of Object.entries(deps ?? {})) {
    if (typeof spec === 'string' && spec.startsWith('workspace:')) {
      const vendored = VENDORED_BY_NAME.get(name)
      if (vendored) out[name] = `file:../${vendored.folder}`
      continue
    }
    out[name] = spec
  }
  return out
}

function runNpmInstall(cwd) {
  runCommand('npm', ['install', '--omit=dev', '--package-lock=false'], { cwd })
}

function materializeLocalDependency(sourceDir, installedDir) {
  rmSync(installedDir, { recursive: true, force: true })
  mkdirSync(path.dirname(installedDir), { recursive: true })
  cpSync(sourceDir, installedDir, { recursive: true })
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
  })

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status)
  }

  if (result.error) {
    throw result.error
  }
}