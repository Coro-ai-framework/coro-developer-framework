import fs from 'fs/promises'
import path from 'path'
import { JobType } from '../jobs/types'
import { ToolContext } from './types'

// ── Security ──────────────────────────────────────────────────────────────────

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
): Promise<unknown> {
  const resolved = resolve(input.path, ctx)
  assertWithin(resolved, readRoots(ctx))
  return await fs.readFile(resolved, 'utf-8')
}

export async function writeFile(
  input: { path: string; content: string },
  ctx: ToolContext,
): Promise<unknown> {
  const resolved = resolve(input.path, ctx)
  assertWithin(resolved, writeRoots(ctx))
  await fs.mkdir(path.dirname(resolved), { recursive: true })
  await fs.writeFile(resolved, input.content, 'utf-8')
  return { wrote: resolved }
}

export async function listDirectory(
  input: { path: string },
  ctx: ToolContext,
): Promise<unknown> {
  const resolved = resolve(input.path, ctx)
  assertWithin(resolved, readRoots(ctx))
  const entries = await fs.readdir(resolved, { withFileTypes: true })
  return entries.map(e => ({
    name: e.name,
    type: e.isDirectory() ? 'directory' : 'file',
  }))
}

export async function createDirectory(
  input: { path: string },
  ctx: ToolContext,
): Promise<unknown> {
  const resolved = resolve(input.path, ctx)
  assertWithin(resolved, writeRoots(ctx))
  await fs.mkdir(resolved, { recursive: true })
  return { created: resolved }
}
