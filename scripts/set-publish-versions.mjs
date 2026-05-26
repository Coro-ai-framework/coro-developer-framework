#!/usr/bin/env node
/**
 * Set the same semver on every npm-publishable package (and bundled internals).
 *
 * Usage:
 *   node scripts/set-publish-versions.mjs 0.2.0
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const manifest = JSON.parse(readFileSync(path.join(__dirname, 'publish-packages.json'), 'utf8'))

const version = process.argv[2]
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
if (!version || !semver.test(version)) {
  console.error('Usage: node scripts/set-publish-versions.mjs <semver>')
  process.exit(1)
}

const relPaths = [...new Set([...(manifest.build ?? manifest.packages), ...manifest.packages])]

for (const rel of relPaths) {
  const file = path.join(root, rel, 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  pkg.version = version
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`${pkg.name} → ${version}`)
}
