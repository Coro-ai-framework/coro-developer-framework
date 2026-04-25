// ── Layer merge primitives ────────────────────────────────────────────────────
//
// The intelligence resolver stacks N layers (base → tenant → repo) into a
// single materialised directory. Two merge modes are supported:
//
//   1. last-wins (default): higher layers replace lower-layer files at
//      the same relative path. Used for `agents/`, `workflows/`,
//      `.claude/skills/`, and everything else.
//
//   2. append (with banners): higher layers append their content under a
//      banner so the model can see provenance. Used for
//      `.claude/CLAUDE.md` and `memory/**/*.md`. Mirrors Claude Code's
//      native CLAUDE.md walk-up semantics.
//
// Why split into helpers: keeps `resolver.ts` focused on orchestration,
// makes merge semantics independently testable, and lets future loaders
// (e.g. a sparse-checkout-based repo loader) reuse the primitives.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/** Merge mode for a given file. */
export type MergeMode = 'replace' | 'append'

/** Banner format used between concatenated layer contents. */
const APPEND_BANNER_PREFIX = '\n\n<!-- ─── coro layer:'
const APPEND_BANNER_SUFFIX = ' ─── -->\n\n'

/**
 * Decide how to merge a file at `relPath` from a higher layer onto a
 * lower-layer destination. The default is `replace`; only specific
 * paths get `append` semantics.
 *
 * Exported for tests and for any future tooling that wants to introspect
 * the merge plan.
 */
export function mergeModeFor(relPath: string): MergeMode {
  // Normalise to POSIX so the rules are platform-independent.
  const p = relPath.split(path.sep).join('/')

  // Claude Code's native CLAUDE.md walk-up concatenates; mirror that.
  if (p === '.claude/CLAUDE.md') return 'append'

  // Memory is cumulative knowledge — append rather than overwrite so that
  // base templates are extended (not replaced) by tenant + repo entries.
  if (p === 'memory' || p.startsWith('memory/')) return 'append'

  return 'replace'
}

/**
 * Apply a single layer (rooted at `srcRoot`) on top of `destRoot` using
 * the per-file merge mode rules.
 *
 * - Recurses through `srcRoot` depth-first.
 * - Skips `.DS_Store` and other OS metadata noise.
 * - For replace-mode files: copies (overwriting).
 * - For append-mode files: concatenates, preceded by a banner that
 *   names the layer so the model can see provenance.
 */
export async function applyLayer(args: {
  srcRoot: string
  destRoot: string
  layerName: string
}): Promise<{ filesApplied: number }> {
  const { srcRoot, destRoot, layerName } = args
  let filesApplied = 0

  async function walk(srcDir: string, destDir: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(srcDir, { withFileTypes: true })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      throw err
    }

    await fs.mkdir(destDir, { recursive: true })

    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue

      const srcPath = path.join(srcDir, entry.name)
      const destPath = path.join(destDir, entry.name)
      const relPath = path.relative(srcRoot, srcPath)

      if (entry.isDirectory()) {
        await walk(srcPath, destPath)
        continue
      }

      // Symlinks: collapse to target file content. Broken symlinks are
      // silently skipped — we never want to materialise them into the
      // overlay and have downstream consumers chase ghosts.
      if (entry.isSymbolicLink()) {
        const target = await fs.readlink(srcPath).catch(() => null)
        if (!target) continue
        const resolved = path.isAbsolute(target) ? target : path.join(srcDir, target)
        const stat = await fs.stat(resolved).catch(() => null)
        if (stat?.isDirectory()) {
          await walk(resolved, destPath)
        } else if (stat?.isFile()) {
          await mergeFile({
            srcPath: resolved,
            destPath,
            relPath,
            layerName,
          })
          filesApplied += 1
        }
        continue
      }

      if (!entry.isFile()) continue

      await mergeFile({
        srcPath,
        destPath,
        relPath,
        layerName,
      })
      filesApplied += 1
    }
  }

  await walk(srcRoot, destRoot)
  return { filesApplied }
}

/**
 * Merge a single file from `srcPath` onto `destPath` using the merge
 * rule for `relPath`. Always reads bytes/strings — does not mutate the
 * source file.
 */
async function mergeFile(args: {
  srcPath: string
  destPath: string
  relPath: string
  layerName: string
}): Promise<void> {
  const { srcPath, destPath, relPath, layerName } = args
  const mode = mergeModeFor(relPath)

  if (mode === 'replace') {
    await fs.mkdir(path.dirname(destPath), { recursive: true })
    await fs.copyFile(srcPath, destPath)
    return
  }

  // append
  const incoming = await fs.readFile(srcPath, 'utf8')
  const existing = await fs.readFile(destPath, 'utf8').catch(() => '')

  await fs.mkdir(path.dirname(destPath), { recursive: true })
  if (existing.length === 0) {
    // First layer to contribute this file — write as-is, with a banner so
    // future appends are clearly delineated and the model has provenance
    // even when only one layer contributes.
    const banner = `${APPEND_BANNER_PREFIX} ${layerName}${APPEND_BANNER_SUFFIX}`.trimStart()
    await fs.writeFile(destPath, banner + incoming)
    return
  }

  const banner = `${APPEND_BANNER_PREFIX} ${layerName}${APPEND_BANNER_SUFFIX}`
  const merged = existing.replace(/\n+$/, '') + banner + incoming
  await fs.writeFile(destPath, merged)
}
