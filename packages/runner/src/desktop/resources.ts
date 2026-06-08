import fs from 'node:fs'
import path from 'node:path'

export const DESKTOP_RESOURCE_SEGMENTS = {
  root: 'coro',
  runnerDir: path.join('coro', 'runner'),
  runnerEntryPoint: path.join('coro', 'runner', 'dist', 'cli', 'index.js'),
  runnerPackageJson: path.join('coro', 'runner', 'package.json'),
  dashboardDistDir: path.join('coro', 'dashboard', 'dist'),
} as const

export interface DesktopResourceLayout {
  resourcesRoot: string
  appRoot: string
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
    runnerDir: path.join(normalizedRoot, DESKTOP_RESOURCE_SEGMENTS.runnerDir),
    runnerEntryPoint: path.join(normalizedRoot, DESKTOP_RESOURCE_SEGMENTS.runnerEntryPoint),
    runnerPackageJson: path.join(normalizedRoot, DESKTOP_RESOURCE_SEGMENTS.runnerPackageJson),
    dashboardDistDir: path.join(normalizedRoot, DESKTOP_RESOURCE_SEGMENTS.dashboardDistDir),
  }
}

export function validateDesktopResourceLayout(layout: DesktopResourceLayout): void {
  const requiredPaths = [
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
