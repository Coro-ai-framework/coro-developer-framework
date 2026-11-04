import { mkdir, rm, readdir, readFile, stat } from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'
import type { ReviewReference } from './policy'

const refreshedAt = new Map<string, number>()

/**
 * Read-only snapshot of a docs or ADR repository. `.git` is removed so the
 * snapshot cannot be pushed and the workspace machinery cannot treat it as
 * the job's target repo. Refreshed at most every `refreshMin` minutes.
 */
export async function ensureReferenceSnapshot(cacheRoot: string, reference: ReviewReference): Promise<string> {
  const dest = path.join(cacheRoot, reference.name)
  const min = (reference.refreshMin ?? 60) * 60_000
  const last = refreshedAt.get(reference.name) ?? 0
  if (Date.now() - last < min) {
    try {
      await stat(dest)
      return dest
    } catch { /* refresh */ }
  }
  const scratch = `${dest}.tmp`
  await rm(scratch, { recursive: true, force: true })
  await mkdir(path.dirname(dest), { recursive: true })
  const ref = reference.ref ?? 'HEAD'
  await git(['clone', '--depth', '1', '--branch', ref, reference.url, scratch]).catch(async () => {
    await git(['clone', '--depth', '1', reference.url, scratch])
  })
  await rm(path.join(scratch, '.git'), { recursive: true, force: true })
  await rm(dest, { recursive: true, force: true })
  await mkdir(path.dirname(dest), { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const mv = spawn('mv', [scratch, dest])
    mv.on('error', reject)
    mv.on('close', code => (code === 0 ? resolve() : reject(new Error('mv failed'))))
  })
  refreshedAt.set(reference.name, Date.now())
  return dest
}

export async function listReferenceDocs(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 2 || out.length > 40) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (/\.(md|mdx|adoc|rst)$/.test(entry.name)) out.push(path.relative(root, full))
    }
  }
  try { await walk(root, 0) } catch { /* missing snapshot */ }
  return out
}

export async function searchReference(root: string, query: string, limit = 20): Promise<{ path: string; line: number; text: string }[]> {
  const hits: { path: string; line: number; text: string }[] = []
  const needle = query.toLowerCase()
  async function walk(dir: string): Promise<void> {
    if (hits.length >= limit) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (hits.length >= limit) return
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!/\.(md|mdx|txt|ya?ml|json|proto)$/.test(entry.name)) continue
      const text = await readFile(full, 'utf8').catch(() => '')
      const lines = text.split('\n')
      for (let i = 0; i < lines.length && hits.length < limit; i++) {
        if (lines[i]!.toLowerCase().includes(needle)) {
          hits.push({ path: path.relative(root, full), line: i + 1, text: lines[i]!.trim().slice(0, 240) })
        }
      }
    }
  }
  await walk(root)
  return hits
}

function git(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`git exited ${code}`))))
  })
}
