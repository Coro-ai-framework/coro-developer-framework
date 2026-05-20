#!/usr/bin/env node
// ── copy-plugin-assets ──────────────────────────────────────────────────────
//
// `tsc` only emits `.ts` → `.js`. Plugin-shipped intelligence is plain
// markdown sitting next to the runtime source, so we mirror those
// files into `dist/src/plugins/builtin/<id>/intelligence/` so the
// production runner finds them at the path
// `path.join(__dirname, 'intelligence')` resolves to.
//
// Kept as a hand-rolled walker (no extra npm dep) because the asset
// surface is tiny — every plugin has at most a handful of files.

const fs = require('node:fs')
const path = require('node:path')

const srcRoot = path.join(__dirname, '..', 'src', 'plugins', 'builtin')
const dstRoot = path.join(__dirname, '..', 'dist', 'src', 'plugins', 'builtin')

function copyTree(src, dst) {
  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) {
      fs.mkdirSync(d, { recursive: true })
      copyTree(s, d)
    } else if (entry.isFile() && /\.(md|json)$/.test(entry.name)) {
      fs.mkdirSync(path.dirname(d), { recursive: true })
      fs.copyFileSync(s, d)
    }
  }
}

if (!fs.existsSync(srcRoot)) {
  process.exit(0)
}
if (!fs.existsSync(dstRoot)) {
  // dist hasn't been built — bail silently so `pnpm build` order
  // (compile-then-copy) is the only path that copies assets.
  process.exit(0)
}

for (const pluginDir of fs.readdirSync(srcRoot, { withFileTypes: true })) {
  if (!pluginDir.isDirectory()) continue
  const intelligenceSrc = path.join(srcRoot, pluginDir.name, 'intelligence')
  const intelligenceDst = path.join(dstRoot, pluginDir.name, 'intelligence')
  if (!fs.existsSync(intelligenceSrc)) continue
  copyTree(intelligenceSrc, intelligenceDst)
}

// Bundled guardrails defaults ship next to dist for runtime resolution.
const configSrc = path.join(__dirname, '..', 'config', 'guardrails.defaults.json')
const configDstDir = path.join(__dirname, '..', 'dist', 'config')
if (fs.existsSync(configSrc)) {
  fs.mkdirSync(configDstDir, { recursive: true })
  fs.copyFileSync(configSrc, path.join(configDstDir, 'guardrails.defaults.json'))
}

console.log('copy-plugin-assets: copied plugin intelligence into dist/')
