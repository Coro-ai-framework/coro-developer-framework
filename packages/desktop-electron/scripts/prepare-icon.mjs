import { cpSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const packageRoot = path.resolve(__dirname, '..')
const workspaceRoot = path.resolve(packageRoot, '../..')
const distRoot = path.join(packageRoot, 'dist')
const tempRoot = path.join(distRoot, '.icon-work')
const iconsetRoot = path.join(tempRoot, 'coro.iconset')
const sourceSvg = path.join(workspaceRoot, 'packages', 'dashboard', 'public', 'favicon.svg')
const renderedPng = path.join(tempRoot, 'favicon.svg.png')
const sourcePng = path.join(tempRoot, 'source-1024.png')
const outputIcns = path.join(distRoot, 'icon.icns')

if (process.platform !== 'darwin') {
  console.log('desktop-electron: skipping mac icon generation on non-darwin host')
  process.exit(0)
}

rmSync(tempRoot, { recursive: true, force: true })
mkdirSync(iconsetRoot, { recursive: true })

runCommand('qlmanage', ['-t', '-s', '1024', '-o', tempRoot, sourceSvg])
renameSync(renderedPng, sourcePng)

const iconVariants = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
]

for (const [fileName, size] of iconVariants) {
  runCommand('sips', ['-z', String(size), String(size), sourcePng, '--out', path.join(iconsetRoot, fileName)])
}

runCommand('iconutil', ['-c', 'icns', iconsetRoot, '-o', outputIcns])
cpSync(sourcePng, path.join(distRoot, 'icon.png'))
rmSync(tempRoot, { recursive: true, force: true })

console.log(`desktop-electron: prepared app icon at ${outputIcns}`)

function runCommand(command, args) {
  const result = spawnSync(command, args, {
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