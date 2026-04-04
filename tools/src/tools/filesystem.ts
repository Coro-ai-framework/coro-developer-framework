import fs from 'fs/promises'
import path from 'path'
import { JobType } from '../jobs/types'
import { ToolContext, ToolResult } from './types'

// ── Security ──────────────────────────────────────────────────────────────────
//
// Every path is resolved to an absolute path and checked against the allowed
// roots before any I/O. Claude cannot escape the sandbox regardless of what
// path string it produces.
//
// Read roots  — always: workingDir + a5aiDir (agents need to read their own
//               instructions, memory, and conventions)
// Write roots — workingDir always; a5aiDir only for SelfUpdate jobs (so agents
//               can author tool proposals and source changes that go through
//               the PR review loop before taking effect)

function readRoots(ctx: ToolContext): string[] {
  return [ctx.settings.paths.workingDir, ctx.settings.paths.a5aiDir]
}

function writeRoots(ctx: ToolContext): string[] {
  const roots = [ctx.settings.paths.workingDir]
  if (ctx.job.type === JobType.SelfUpdate) {
    roots.push(ctx.settings.paths.a5aiDir)
  }
  return roots
}

function resolve(filePath: string, ctx: ToolContext): string {
  // Absolute paths are used as-is; relative paths resolve from workingDir
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(ctx.settings.paths.workingDir, filePath)
}

function assertWithin(resolved: string, roots: string[]): void {
  const ok = roots.some(r => resolved === r || resolved.startsWith(r + path.sep))
  if (!ok) {
    throw new Error(
      `Path "${resolved}" is outside allowed directories.\n` +
      `Allowed: ${roots.join(', ')}`,
    )
  }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export async function readFile(
  input: { path: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const resolved = resolve(input.path, ctx)
  try {
    assertWithin(resolved, readRoots(ctx))
    const content = await fs.readFile(resolved, 'utf-8')
    return { success: true, output: content }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function writeFile(
  input: { path: string; content: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const resolved = resolve(input.path, ctx)
  try {
    assertWithin(resolved, writeRoots(ctx))
    await fs.mkdir(path.dirname(resolved), { recursive: true })
    await fs.writeFile(resolved, input.content, 'utf-8')
    return { success: true, output: { wrote: resolved } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function listDirectory(
  input: { path: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const resolved = resolve(input.path, ctx)
  try {
    assertWithin(resolved, readRoots(ctx))
    const entries = await fs.readdir(resolved, { withFileTypes: true })
    const output = entries.map(e => ({
      name: e.name,
      type: e.isDirectory() ? 'directory' : 'file',
    }))
    return { success: true, output }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function createDirectory(
  input: { path: string },
  ctx: ToolContext,
): Promise<ToolResult> {
  const resolved = resolve(input.path, ctx)
  try {
    assertWithin(resolved, writeRoots(ctx))
    await fs.mkdir(resolved, { recursive: true })
    return { success: true, output: { created: resolved } }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
