// ── Intelligence provenance ──────────────────────────────────────────────────
//
// Distills the overlay the resolver just applied into a stamp the
// retrospective can read later: which runner, which base layer, which
// tenant/repo revisions. Best-effort — a missing git SHA must not stall
// a job.

import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { BASE_LAYER_VERSION } from '@coro-ai/intelligence-base'
import type { IntelligenceProvenance, IntelligenceProvenanceLayer } from '@coro-ai/cloud-protocol'

import type { AppliedLayer, ResolvedIntelligence } from './resolver'
import { runnerVersion } from '../version'

const DIGEST_FILE_CAP = 200

export async function captureIntelligenceProvenance(
  resolved: ResolvedIntelligence,
  now: () => string = () => new Date().toISOString(),
): Promise<IntelligenceProvenance> {
  const layers: IntelligenceProvenanceLayer[] = []
  for (const layer of resolved.layers) {
    layers.push(await describeLayer(layer))
  }
  return {
    recordedAt: now(),
    runnerVersion: runnerVersion(),
    baseLayerVersion: BASE_LAYER_VERSION,
    layers,
  }
}

async function describeLayer(layer: AppliedLayer): Promise<IntelligenceProvenanceLayer> {
  const revision = (await readGitHead(layer.source)) ?? (await digestTree(layer.source))
  return {
    name: layer.name,
    source: layer.source,
    fileCount: layer.fileCount,
    ...(revision ? { revision } : {}),
  }
}

async function readGitHead(dir: string): Promise<string | undefined> {
  try {
    const headPath = path.join(dir, '.git', 'HEAD')
    const head = (await fs.readFile(headPath, 'utf8')).trim()
    if (/^[0-9a-f]{40,}$/i.test(head)) return head
    const ref = head.match(/^ref:\s*(.+)$/)?.[1]?.trim()
    if (!ref) return undefined
    const sha = (await fs.readFile(path.join(dir, '.git', ref), 'utf8')).trim()
    return /^[0-9a-f]{40,}$/i.test(sha) ? sha : undefined
  } catch {
    return undefined
  }
}

async function digestTree(dir: string): Promise<string | undefined> {
  try {
    const files: string[] = []
    await walkFiles(dir, dir, files)
    if (files.length === 0) return undefined
    files.sort()
    const hash = crypto.createHash('sha256')
    for (const relative of files.slice(0, DIGEST_FILE_CAP)) {
      const stat = await fs.stat(path.join(dir, relative))
      hash.update(relative)
      hash.update('\0')
      hash.update(String(stat.size))
      hash.update('\n')
    }
    hash.update(String(files.length))
    return hash.digest('hex').slice(0, 16)
  } catch {
    return undefined
  }
}

async function walkFiles(root: string, current: string, out: string[]): Promise<void> {
  if (out.length >= DIGEST_FILE_CAP) return
  const entries = await fs.readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const abs = path.join(current, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(root, abs, out)
    } else if (entry.isFile()) {
      out.push(path.relative(root, abs).split(path.sep).join('/'))
      if (out.length >= DIGEST_FILE_CAP) return
    }
  }
}
