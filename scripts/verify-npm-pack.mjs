#!/usr/bin/env node
/**
 * Smoke-test that publishable packages pack cleanly after a workspace build.
 * Does not publish — writes tarballs to .npm-pack-verify/
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const outDir = path.join(root, '.npm-pack-verify')
const manifest = JSON.parse(readFileSync(path.join(__dirname, 'publish-packages.json'), 'utf8'))

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

execFileSync('node', ['scripts/prepare-runner-npm-publish.mjs'], {
  cwd: root,
  stdio: 'inherit',
})

for (const rel of manifest.packages) {
  const pkgDir = rel === 'packages/runner' ? path.join(root, rel, '.npm-publish') : path.join(root, rel)
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  if (pkg.private) {
    console.error(`::error::${pkg.name} is still private — remove "private": true before publishing`)
    process.exit(1)
  }

  const packCmd = rel === 'packages/runner' ? 'npm' : 'pnpm'
  const packArgs =
    rel === 'packages/runner'
      ? ['pack', '--pack-destination', outDir]
      : ['pack', '--pack-destination', outDir]

  execFileSync(packCmd, packArgs, {
    cwd: pkgDir,
    stdio: 'inherit',
  })
  console.log(`packed ${pkg.name}@${pkg.version}`)

  if (rel === 'packages/runner') {
    verifyRunnerTarballRuntimeDeps(outDir, pkg)
  }
}

console.log(`\nAll ${manifest.packages.length} packages packed to ${outDir}`)

function verifyRunnerTarballRuntimeDeps(outDir, pkg) {
  const tarball = path.join(outDir, `${pkg.name.replace('/', '-')}-${pkg.version}.tgz`)
  if (!existsSync(tarball)) {
    console.error(`::error::Expected runner pack tarball at ${tarball}`)
    process.exit(1)
  }
  const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  for (const dep of ['package/node_modules/pino/package.json', 'package/node_modules/express/package.json']) {
    if (!listing.includes(dep)) {
      console.error(`::error::Runner tarball missing ${dep} — global \`npm install -g\` will break (see prepare-runner-npm-publish.mjs)`)
      process.exit(1)
    }
  }
  console.log('runner tarball includes vendored production node_modules (pino, express, …)')
}
