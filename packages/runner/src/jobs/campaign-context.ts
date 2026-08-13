// ── Campaign child context materialisation ───────────────────────────────────
//
// Campaign children run in an isolated per-job working directory. Parent
// campaign artefacts (markdown/json written by upstream campaign phases)
// are copied into `{childJobDir}/campaign/` at dispatch. When a child
// finishes, any markdown/json it wrote under that folder is synced back
// to the parent job directory (preserving relative paths).
//
// No intelligence artefact *names* are hardcoded here — only structural
// constants (`campaign/`, `.md`/`.json` extensions, runtime skip dirs).

import fs from 'node:fs/promises'
import path from 'node:path'
import type { Job } from '@coro-ai/cloud-protocol'
import { isPathInside } from '@coro-ai/plugin-sdk'
import { UPSTREAM_SOURCE_SUBDIR } from '../tools/upstream-source'
import { buildPrimaryRepoCandidates } from './workspace-layout'

/** Subdirectory under each campaign child job root for copied parent context. */
export const CAMPAIGN_CONTEXT_DIR = 'campaign'

const CONTEXT_EXTENSIONS = new Set(['.md', '.json'])

/**
 * Runtime top-level dirs under a job working root — never campaign context.
 * `_upstream` holds a snapshot of a whole repository; sweeping its markdown
 * into every child job would drown the actual parent artefacts.
 */
const RUNTIME_TOP_LEVEL_DIRS = new Set([
  '_intelligence',
  '.claude',
  UPSTREAM_SOURCE_SUBDIR,
  CAMPAIGN_CONTEXT_DIR,
])

export function buildCampaignContextSkipDirs(job: Job): Set<string> {
  const skip = new Set(RUNTIME_TOP_LEVEL_DIRS)
  for (const rel of buildPrimaryRepoCandidates(job)) {
    skip.add(rel)
    const top = rel.split(/[/\\]/)[0]
    if (top) skip.add(top)
  }
  return skip
}

function isContextFile(name: string): boolean {
  return CONTEXT_EXTENSIONS.has(path.extname(name).toLowerCase())
}

function toPosixRel(rel: string): string {
  return rel.split(path.sep).join('/')
}

async function walkContextFiles(
  root: string,
  skipTopLevelDirs: Set<string>,
  onFile: (relativePath: string) => Promise<void>,
): Promise<void> {
  async function walk(absDir: string, relPrefix: string): Promise<void> {
    let entries
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }

    for (const ent of entries) {
      const rel = relPrefix ? path.join(relPrefix, ent.name) : ent.name
      if (!relPrefix && skipTopLevelDirs.has(ent.name)) continue

      const abs = path.join(absDir, ent.name)
      if (ent.isDirectory()) {
        await walk(abs, rel)
      } else if (ent.isFile() && isContextFile(ent.name)) {
        await onFile(rel)
      }
    }
  }

  await walk(root, '')
}

/**
 * Copy markdown/json files from the parent campaign working dir into
 * `{childWorkingDir}/campaign/`, preserving relative paths.
 */
export async function materializeCampaignContext(args: {
  parentJob: Job
  parentWorkingDir: string
  childWorkingDir: string
}): Promise<{ copied: string[] }> {
  const destRoot = path.join(args.childWorkingDir, CAMPAIGN_CONTEXT_DIR)
  await fs.mkdir(destRoot, { recursive: true })

  try {
    await fs.access(args.parentWorkingDir)
  } catch {
    return { copied: [] }
  }

  const skip = buildCampaignContextSkipDirs(args.parentJob)
  const copied: string[] = []

  await walkContextFiles(args.parentWorkingDir, skip, async (rel) => {
    const src = path.join(args.parentWorkingDir, rel)
    const dest = path.join(destRoot, rel)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.copyFile(src, dest)
    copied.push(toPosixRel(rel))
  })

  return { copied }
}

/**
 * Mirror markdown/json files from `{childWorkingDir}/campaign/` back to the
 * parent campaign working dir (preserving relative paths).
 */
export async function syncCampaignContextToParent(args: {
  childWorkingDir: string
  parentWorkingDir: string
}): Promise<{ synced: string[] }> {
  const sourceRoot = path.join(args.childWorkingDir, CAMPAIGN_CONTEXT_DIR)
  const synced: string[] = []

  try {
    await fs.access(sourceRoot)
  } catch {
    return { synced }
  }

  await walkContextFiles(sourceRoot, new Set(), async (rel) => {
    const src = path.join(sourceRoot, rel)
    const dest = path.join(args.parentWorkingDir, rel)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.copyFile(src, dest)
    synced.push(toPosixRel(rel))
  })

  return { synced }
}

/**
 * Resolve a param path string to a path relative to the parent job working
 * directory, or null when the string does not refer to the parent tree.
 */
export function resolveParentJobRelativePath(
  raw: string,
  parentWorkingDir: string,
  parentJobId: string,
): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const parentAbs = path.resolve(parentWorkingDir)

  const workingPrefixes = [
    `working/${parentJobId}/`,
    `working/${parentJobId}`,
    `working\\${parentJobId}\\`,
    `working\\${parentJobId}`,
  ]
  for (const prefix of workingPrefixes) {
    if (trimmed.startsWith(prefix)) {
      const rest = trimmed.slice(prefix.length).replace(/^[/\\]+/, '')
      if (!rest) return null
      const resolved = path.resolve(parentAbs, rest)
      return isPathInside(resolved, parentAbs) ? path.relative(parentAbs, resolved) : null
    }
  }

  if (path.isAbsolute(trimmed)) {
    const resolved = path.resolve(trimmed)
    return isPathInside(resolved, parentAbs) ? path.relative(parentAbs, resolved) : null
  }

  if (!looksLikePathReference(trimmed, parentJobId)) return null

  const resolved = path.resolve(parentAbs, trimmed)
  if (!isPathInside(resolved, parentAbs)) return null
  return path.relative(parentAbs, resolved)
}

function looksLikePathReference(raw: string, parentJobId: string): boolean {
  if (!isContextFile(raw) && !raw.includes('/') && !raw.includes('\\')) return false
  if (raw.includes(parentJobId)) return true
  if (raw.startsWith('working/') || raw.startsWith('working\\')) return true
  return raw.includes('/') || raw.includes('\\')
}

async function parentContextFileExists(parentWorkingDir: string, rel: string): Promise<boolean> {
  try {
    await fs.access(path.join(parentWorkingDir, rel))
    return true
  } catch {
    return false
  }
}

function rewritePathStringForChild(
  raw: string,
  parentWorkingDir: string,
  parentJobId: string,
  existingParentRelPaths: ReadonlySet<string>,
): string {
  const rel = resolveParentJobRelativePath(raw, parentWorkingDir, parentJobId)
  if (!rel || !isContextFile(rel)) return raw
  const normalized = toPosixRel(rel)
  if (!existingParentRelPaths.has(normalized) && !existingParentRelPaths.has(rel)) return raw
  return path.posix.join(CAMPAIGN_CONTEXT_DIR, normalized)
}

function collectPathStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathStrings(item, out)
    return
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectPathStrings(v, out)
  }
}

function rewriteNestedParams(
  value: unknown,
  parentWorkingDir: string,
  parentJobId: string,
  existingParentRelPaths: ReadonlySet<string>,
): unknown {
  if (typeof value === 'string') {
    return rewritePathStringForChild(value, parentWorkingDir, parentJobId, existingParentRelPaths)
  }
  if (Array.isArray(value)) {
    return value.map(v => rewriteNestedParams(v, parentWorkingDir, parentJobId, existingParentRelPaths))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = rewriteNestedParams(v, parentWorkingDir, parentJobId, existingParentRelPaths)
    }
    return out
  }
  return value
}

/**
 * Inject `campaignContextDir` and rewrite param path strings that refer to
 * parent campaign markdown/json files so they point under `campaign/`.
 */
export async function prepareCampaignChildParams(args: {
  params: Record<string, unknown>
  parentWorkingDir: string
  parentJobId: string
  copiedRelativePaths: readonly string[]
}): Promise<Record<string, unknown>> {
  const existing = new Set<string>(args.copiedRelativePaths.map(toPosixRel))

  // Also accept paths declared in params that exist on the parent even if
  // the copy pass skipped them (defensive — should not happen for md/json).
  const declared: string[] = []
  collectPathStrings(args.params, declared)
  for (const raw of declared) {
    const rel = resolveParentJobRelativePath(raw, args.parentWorkingDir, args.parentJobId)
    if (!rel || !isContextFile(rel)) continue
    if (await parentContextFileExists(args.parentWorkingDir, rel)) {
      existing.add(toPosixRel(rel))
    }
  }

  const rewritten = rewriteNestedParams(
    args.params,
    args.parentWorkingDir,
    args.parentJobId,
    existing,
  ) as Record<string, unknown>

  return {
    ...rewritten,
    campaignContextDir: CAMPAIGN_CONTEXT_DIR,
  }
}
