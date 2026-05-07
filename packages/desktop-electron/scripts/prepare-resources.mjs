import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const nodeTargetDir = path.join(appResourcesRoot, 'bin')
const nodeTargetPath = path.join(nodeTargetDir, process.platform === 'win32' ? 'node.exe' : 'node')
const runnerSourceDir = path.join(workspaceRoot, 'packages', 'runner')
const dashboardSourceDir = path.join(workspaceRoot, 'packages', 'dashboard', 'dist')
const intelligenceSourceDir = path.join(workspaceRoot, 'packages', 'intelligence-base')
const PNPM_COMMAND = resolveCommand('pnpm')
const NPM_COMMAND = resolveCommand('npm')

runPnpm(['--filter', '@coro/intelligence-base', 'build'])
runPnpm(['--filter', '@coro/runner', 'build'])
runPnpm(['--filter', '@coro/dashboard', 'build'])

rmSync(resourcesRoot, { recursive: true, force: true })
rmSync(stagingRoot, { recursive: true, force: true })
mkdirSync(resourcesRoot, { recursive: true })

prepareRunnerBundle(runnerDeployDir)
cpSync(runnerDeployDir, runnerTargetDir, { recursive: true })
cpSync(dashboardSourceDir, dashboardTargetDir, { recursive: true })

mkdirSync(nodeTargetDir, { recursive: true })
copyFileSync(process.execPath, nodeTargetPath)
chmodSync(nodeTargetPath, 0o755)

rmSync(stagingRoot, { recursive: true, force: true })

console.log(`desktop-electron: prepared packaged resources under ${resourcesRoot}`)

function runPnpm(args) {
  const result = spawnSync(PNPM_COMMAND, ['--dir', workspaceRoot, ...args], {
    stdio: 'inherit',
    env: process.env,
  })

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status)
  }

  if (result.error) {
    throw result.error
  }
}

function prepareRunnerBundle(runnerRoot) {
  const stagedIntelligenceDir = path.join(runnerRoot, 'vendor', 'intelligence-base')
  const installedIntelligenceDir = path.join(runnerRoot, 'node_modules', '@coro', 'intelligence-base')

  mkdirSync(runnerRoot, { recursive: true })

  cpSync(path.join(runnerSourceDir, 'dist'), path.join(runnerRoot, 'dist'), { recursive: true })
  cpSync(path.join(intelligenceSourceDir, 'dist'), path.join(stagedIntelligenceDir, 'dist'), { recursive: true })
  cpSync(path.join(intelligenceSourceDir, 'layer'), path.join(stagedIntelligenceDir, 'layer'), { recursive: true })
  copyFileSync(
    path.join(intelligenceSourceDir, 'README.md'),
    path.join(stagedIntelligenceDir, 'README.md'),
  )

  const runnerPackage = JSON.parse(readFileSync(path.join(runnerSourceDir, 'package.json'), 'utf8'))
  const intelligencePackage = JSON.parse(readFileSync(path.join(intelligenceSourceDir, 'package.json'), 'utf8'))

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
        dependencies: {
          ...runnerPackage.dependencies,
          '@coro/intelligence-base': 'file:./vendor/intelligence-base',
        },
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(
    path.join(stagedIntelligenceDir, 'package.json'),
    JSON.stringify(
      {
        name: intelligencePackage.name,
        version: intelligencePackage.version,
        description: intelligencePackage.description,
        private: true,
        type: intelligencePackage.type,
        main: intelligencePackage.main,
        types: intelligencePackage.types,
        files: intelligencePackage.files,
        exports: intelligencePackage.exports,
      },
      null,
      2,
    ) + '\n',
  )

  runNpmInstall(runnerRoot)
  materializeLocalDependency(stagedIntelligenceDir, installedIntelligenceDir)
  rmSync(path.join(runnerRoot, 'node_modules', '.bin'), { recursive: true, force: true })
  rmSync(path.join(runnerRoot, 'vendor'), { recursive: true, force: true })
  rmSync(path.join(runnerRoot, 'package-lock.json'), { recursive: true, force: true })
}

function runNpmInstall(cwd) {
  const result = spawnSync(
    NPM_COMMAND,
    ['install', '--omit=dev', '--package-lock=false'],
    {
      cwd,
      stdio: 'inherit',
      env: process.env,
    },
  )

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status)
  }

  if (result.error) {
    throw result.error
  }
}

function materializeLocalDependency(sourceDir, installedDir) {
  rmSync(installedDir, { recursive: true, force: true })
  mkdirSync(path.dirname(installedDir), { recursive: true })
  cpSync(sourceDir, installedDir, { recursive: true })
}

function resolveCommand(command) {
  return process.platform === 'win32' ? `${command}.cmd` : command
}