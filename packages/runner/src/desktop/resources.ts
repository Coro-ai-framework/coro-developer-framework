import fs from 'node:fs'
import path from 'node:path'

const NODE_EXECUTABLE_NAME = process.platform === 'win32' ? 'node.exe' : 'node'

export const DESKTOP_RESOURCE_SEGMENTS = {
  root: 'coro',
  nodeBinDir: path.join('coro', 'bin'),
  runnerDir: path.join('coro', 'runner'),
  runnerEntryPoint: path.join('coro', 'runner', 'dist', 'cli', 'index.js'),
  runnerPackageJson: path.join('coro', 'runner', 'package.json'),
  dashboardDistDir: path.join('coro', 'dashboard', 'dist'),
} as const

export interface DesktopResourceLayout {
  resourcesRoot: string
  appRoot: string
  nodeExecutable: string
  runnerDir: string
  runnerEntryPoint: string
  runnerPackageJson: string
  dashboardDistDir: string
}

export function resolveDesktopResourceLayout(resourcesRoot: string): DesktopResourceLayout {
  const normalizedRoot = path.resolve(resourcesRoot)

  return {
    resourcesRoot: normalizedRoot,
    appRoot: path.join(normalizedRoot, DESKTOP_RESOURCE_SEGMENTS.root),
    nodeExecutable: path.join(normalizedRoot, DESKTOP_RESOURCE_SEGMENTS.nodeBinDir, NODE_EXECUTABLE_NAME),
    runnerDir: path.join(normalizedRoot, DESKTOP_RESOURCE_SEGMENTS.runnerDir),
    runnerEntryPoint: path.join(normalizedRoot, DESKTOP_RESOURCE_SEGMENTS.runnerEntryPoint),
    runnerPackageJson: path.join(normalizedRoot, DESKTOP_RESOURCE_SEGMENTS.runnerPackageJson),
    dashboardDistDir: path.join(normalizedRoot, DESKTOP_RESOURCE_SEGMENTS.dashboardDistDir),
  }
}

export function validateDesktopResourceLayout(layout: DesktopResourceLayout): void {
  const requiredPaths = [
    layout.nodeExecutable,
    layout.runnerDir,
    layout.runnerEntryPoint,
    layout.runnerPackageJson,
    layout.dashboardDistDir,
    path.join(layout.dashboardDistDir, 'index.html'),
  ]

  const missing = requiredPaths.filter((candidate) => !fs.existsSync(candidate))
  if (missing.length > 0) {
    throw new Error(
      [
        'Desktop resource layout is incomplete.',
        `Resources root: ${layout.resourcesRoot}`,
        `Missing paths: ${missing.join(', ')}`,
      ].join(' '),
    )
  }
}