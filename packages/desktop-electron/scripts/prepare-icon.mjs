import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import pngToIco from 'png-to-ico'
import sharp from 'sharp'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const packageRoot = path.resolve(__dirname, '..')
const workspaceRoot = path.resolve(packageRoot, '../..')
const distRoot = path.join(packageRoot, 'dist')
const tempRoot = path.join(distRoot, '.icon-work')
const iconsetRoot = path.join(tempRoot, 'coro.iconset')
// App icon source: a dedicated SVG that mirrors the dashboard's in-app
// `BrandMark` glyph (accent "C" arc + dot on the translucent accent-tinted
// chip), rather than the slimmer browser-tab favicon. Keeps the desktop app
// visually consistent with what users see inside the running dashboard.
const sourceSvg = path.join(packageRoot, 'assets', 'app-icon.svg')
const sourcePng = path.join(tempRoot, 'source-1024.png')
const outputIcns = path.join(distRoot, 'icon.icns')
const outputIco = path.join(distRoot, 'icon.ico')

rmSync(tempRoot, { recursive: true, force: true })
rmSync(outputIcns, { force: true })
rmSync(outputIco, { force: true })
mkdirSync(iconsetRoot, { recursive: true })

await sharp(sourceSvg)
  .resize(1024, 1024)
  .png()
  .toFile(sourcePng)

const icoVariants = [16, 24, 32, 48, 64, 128, 256]
const icoVariantPaths = []

for (const size of icoVariants) {
  const filePath = path.join(tempRoot, `icon-${size}.png`)
  await sharp(sourcePng)
    .resize(size, size)
    .png()
    .toFile(filePath)
  icoVariantPaths.push(filePath)
}

const icoBuffer = await pngToIco(icoVariantPaths)
writeFileSync(outputIco, icoBuffer)

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

if (process.platform === 'darwin') {
  for (const [fileName, size] of iconVariants) {
    await sharp(sourcePng)
      .resize(size, size)
      .png()
      .toFile(path.join(iconsetRoot, fileName))
  }

  runCommand('iconutil', ['-c', 'icns', iconsetRoot, '-o', outputIcns])
}

cpSync(sourcePng, path.join(distRoot, 'icon.png'))
rmSync(tempRoot, { recursive: true, force: true })

console.log(
  `desktop-electron: prepared app icons at ${outputIco}${process.platform === 'darwin' ? ` and ${outputIcns}` : ''}`,
)

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