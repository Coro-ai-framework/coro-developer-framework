// ── Local diff source ────────────────────────────────────────────────────────
//
// Reads the change under review from a git checkout instead of an SCM API,
// for the review that runs before a pull request exists. The result has the
// same shape as a pull request diff, so the packet, routing, and patch ids
// in `packet.ts` and `prepare.ts` work unchanged.

import { execFile } from 'child_process'
import { readFile, stat } from 'fs/promises'
import path from 'path'
import type { ScmPrDiff } from '../plugins/types'

const MAX_BUFFER = 64 * 1024 * 1024
const MAX_UNTRACKED_BYTES = 400_000

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')} failed: ${(stderr || err.message).trim()}`))
      else resolve(stdout)
    })
  })
}

const STATUS_WORD: Record<string, string> = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'added', T: 'modified' }

/** Splits `git diff` output into one patch per file, keyed by the new path. */
export function splitPatches(diff: string): Map<string, string> {
  const out = new Map<string, string>()
  const parts = diff.split(/^(?=diff --git )/m).filter(part => part.startsWith('diff --git '))
  for (const part of parts) {
    const plus = part.match(/^\+\+\+ b\/(.+)$/m)
    const header = part.match(/^diff --git a\/(.+?) b\/(.+)$/m)
    const filePath = plus?.[1] ?? header?.[2]
    if (!filePath) continue
    // The SCM patch format starts at the first hunk.
    const hunk = part.indexOf('\n@@')
    out.set(filePath, hunk === -1 ? '' : part.slice(hunk + 1).replace(/\n$/, ''))
  }
  return out
}

/**
 * The remote-tracking branch is preferred: a stale local branch would pull
 * commits the coder did not write into the diff.
 */
async function resolveBase(checkoutDir: string, base: string): Promise<string> {
  const name = base.trim()
  if (!name || name.startsWith('-')) throw new Error(`"${base}" is not a usable base ref`)
  for (const candidate of [`origin/${name}`, name]) {
    const ok = await git(checkoutDir, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]).then(() => true, () => false)
    if (ok) return candidate
  }
  throw new Error(`Base ref "${base}" does not exist in ${checkoutDir}. Pass the branch the pull request will target.`)
}

/**
 * Everything on the checkout that differs from the merge base with `base`:
 * commits on the branch and uncommitted edits, so a coder can review before
 * it commits. Untracked files are included as additions. Read-only: the
 * checkout's index and working tree are left as they were.
 */
export async function readLocalDiff(checkoutDir: string, base: string): Promise<ScmPrDiff> {
  const resolved = await resolveBase(checkoutDir, base)
  const target = (await git(checkoutDir, ['merge-base', resolved, 'HEAD'])).trim()
  const [names, numstat, patch] = await Promise.all([
    git(checkoutDir, ['diff', '--name-status', '-M', target]),
    git(checkoutDir, ['diff', '--numstat', '-M', target]),
    git(checkoutDir, ['diff', '-M', '--no-color', target]),
  ])
  const patches = splitPatches(patch)
  const counts = new Map<string, { additions: number; deletions: number }>()
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [add, del, ...rest] = line.split('\t')
    const raw = rest.join('\t')
    const name = raw.includes(' => ') ? raw.replace(/^.*\{.* => (.*)\}(.*)$/, '$1$2').replace(/^.* => /, '') : raw
    counts.set(name, { additions: Number(add) || 0, deletions: Number(del) || 0 })
  }
  const files: ScmPrDiff['files'] = []
  for (const line of names.split('\n').filter(Boolean)) {
    const [code = 'M', first = '', second] = line.split('\t')
    const filePath = second ?? first
    const count = counts.get(filePath) ?? { additions: 0, deletions: 0 }
    const filePatch = patches.get(filePath)
    files.push({
      path: filePath,
      status: STATUS_WORD[code[0] ?? 'M'] ?? 'modified',
      additions: count.additions,
      deletions: count.deletions,
      ...(filePatch ? { patch: filePatch } : {}),
    })
  }
  // New files the coder has not added yet. Read them directly: marking them
  // with `git add -N` would change the index the coder is working in.
  const untracked = (await git(checkoutDir, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean)
  for (const rel of untracked) {
    if (files.some(file => file.path === rel)) continue
    const abs = path.join(checkoutDir, rel)
    try {
      const info = await stat(abs)
      if (!info.isFile() || info.size > MAX_UNTRACKED_BYTES) {
        files.push({ path: rel, status: 'added', additions: 0, deletions: 0 })
        continue
      }
      const text = (await readFile(abs)).toString('utf8')
      if (text.includes('\0')) {
        files.push({ path: rel, status: 'added', additions: 0, deletions: 0 })
        continue
      }
      const lines = text.split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      files.push({
        path: rel,
        status: 'added',
        additions: lines.length,
        deletions: 0,
        patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}`,
      })
    } catch {
      files.push({ path: rel, status: 'added', additions: 0, deletions: 0 })
    }
  }
  return { files }
}
