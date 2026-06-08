#!/usr/bin/env node
/**
 * electron-builder afterSign hook — verify the packaged app and bundled Claude
 * binary are signed when macOS signing inputs are present.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default async function verifyMacSigning(context) {
  if (process.platform !== 'darwin') {
    console.log('verify-mac-signing: skipping on non-macOS host')
    return
  }

  if (!process.env.CSC_LINK) {
    console.log('verify-mac-signing: CSC_LINK not set — skipping signature verification')
    return
  }

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  if (!existsSync(appPath)) {
    throw new Error(`verify-mac-signing: app bundle not found at ${appPath}`)
  }

  assertCodesignValid(appPath, 'application bundle')

  const claudeBinary = path.join(
    appPath,
    'Contents/Resources/coro/runner/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
  )
  if (existsSync(claudeBinary)) {
    assertCodesignValid(claudeBinary, 'Claude Agent SDK binary')
  } else {
    console.warn(`verify-mac-signing: Claude binary not found at ${claudeBinary} — skipping`)
  }

  const assess = spawnSync('spctl', ['-a', '-vv', appPath], { encoding: 'utf8' })
  if (assess.status !== 0) {
    console.warn('verify-mac-signing: spctl assessment did not pass (notarization may still be in flight)')
    console.warn(assess.stdout)
    console.warn(assess.stderr)
  } else {
    console.log('verify-mac-signing: Gatekeeper assessment passed')
  }

  console.log('verify-mac-signing: macOS signing verification complete')
}

function assertCodesignValid(targetPath, label) {
  const result = spawnSync('codesign', ['-dv', '--verbose=2', targetPath], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `verify-mac-signing: ${label} is not signed: ${targetPath}\n${result.stderr ?? result.stdout}`,
    )
  }
  console.log(`verify-mac-signing: ${label} signed — ${targetPath}`)
}
