// ── Intelligence Catalogue ──────────────────────────────────────────────────
//
// Walks every intelligence layer the runner knows about and produces a flat,
// JSON-serialisable list of artefacts (workflows, agents, skills, memory
// files) annotated with their `layer` and an `overrides` field when a
// higher-priority layer is shadowing a lower one.
//
// Used by `GET /intelligence/layers` to populate the dashboard's Intelligence
// page. The shape is deliberately read-only: this module never writes to disk.
// Edit/scaffold endpoints land in a later phase.
//
// Why a separate module from `workflow-discovery.ts`?
//   - workflow-discovery returns the **executable** view (parsed phases,
//     initial phase, etc.) the new-run page needs.
//   - This module returns the **inventory** view: just enough metadata to
//     render a layer map and let the user click through to the inspector.
//   We share the layer-tagging pattern but keep the data shapes separate so
//   the inventory endpoint stays cheap.

import fs from 'fs/promises'
import path from 'path'
import type { Logger } from 'pino'
import type { IntelligenceLayer, LayerRoot } from './workflow-discovery'

export type ArtefactKind = 'workflow' | 'agent' | 'skill' | 'memory'

export interface Artefact {
  /** Stable key: relative path within the layer root. Same across layers. */
  path: string
  /** Coarse classification used to drive UI grouping. */
  kind: ArtefactKind
  /** Human-friendly label (front-matter `display_name`, H1, or filename). */
  displayName: string
  /** One-line summary, when extractable. */
  description: string
  /** Layer this artefact was served from. */
  layer: IntelligenceLayer
  /** Lower-priority layer this entry shadows, if any. */
  overrides?: IntelligenceLayer
  /** Absolute path to the layer root that resolved this artefact. */
  source: string
}

export interface LayerInfo {
  layer: IntelligenceLayer
  root: string
  /** True if the directory exists on disk. */
  exists: boolean
  /**
   * True if this layer is intended to be edited by the user. Base ships
   * with the runner and is treated as read-only; tenant and repo are
   * writable.
   */
  writable: boolean
  /** Per-kind artefact counts contributed by this layer (incl. overrides). */
  counts: Record<ArtefactKind, number>
}

export interface IntelligenceCatalogue {
  layers: LayerInfo[]
  artefacts: Artefact[]
}

const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---/
const H1_RE = /^#\s+(.+?)\s*$/m

function parseFrontMatterDisplayName(markdown: string): string | null {
  const match = FRONT_MATTER_RE.exec(markdown)
  if (!match) return null
  // Cheap prefix scan rather than full YAML parse — we only care about
  // top-level `display_name:` and `name:` strings.
  for (const line of match[1].split('\n')) {
    const m = /^(display_name|name):\s*(.+?)\s*$/i.exec(line)
    if (m && m[2]) {
      return m[2].replace(/^['"]|['"]$/g, '').trim()
    }
  }
  return null
}

function parseFrontMatterDescription(markdown: string): string | null {
  const match = FRONT_MATTER_RE.exec(markdown)
  if (!match) return null
  for (const line of match[1].split('\n')) {
    const m = /^description:\s*(.+?)\s*$/i.exec(line)
    if (m && m[1]) {
      return m[1].replace(/^['"]|['"]$/g, '').trim()
    }
  }
  return null
}

function extractFirstH1(markdown: string): string | null {
  const body = markdown.replace(FRONT_MATTER_RE, '')
  const match = H1_RE.exec(body)
  if (!match) return null
  return match[1].replace(/^workflow:\s*/i, '').replace(/^agent:\s*/i, '').replace(/^skill:\s*/i, '').trim()
}

function extractFirstParagraph(markdown: string): string {
  const body = markdown.replace(FRONT_MATTER_RE, '').trimStart()
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length && (lines[i].startsWith('#') || lines[i].trim() === '')) i++
  const paragraph: string[] = []
  while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('#')) {
    paragraph.push(lines[i].trim())
    i++
  }
  const collapsed = paragraph.join(' ').replace(/\s+/g, ' ').trim()
  if (collapsed.length <= 200) return collapsed
  return collapsed.slice(0, 197).trimEnd() + '…'
}

async function safeReadFile(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch {
    return null
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

async function readWorkflowsForLayer(layer: IntelligenceLayer, root: string): Promise<Artefact[]> {
  const dir = path.join(root, 'workflows')
  const entries = await safeReaddir(dir)
  const out: Artefact[] = []
  for (const entry of entries) {
    const file = path.join(dir, entry, 'workflow.md')
    const content = await safeReadFile(file)
    if (content === null) continue
    out.push({
      path: `workflows/${entry}/workflow.md`,
      kind: 'workflow',
      displayName:
        parseFrontMatterDisplayName(content) ?? extractFirstH1(content) ?? entry,
      description:
        parseFrontMatterDescription(content) ?? extractFirstParagraph(content),
      layer,
      source: root,
    })
  }
  return out
}

async function readAgentsForLayer(layer: IntelligenceLayer, root: string): Promise<Artefact[]> {
  const dir = path.join(root, 'agents')
  const entries = await safeReaddir(dir)
  const out: Artefact[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const file = path.join(dir, entry)
    const content = await safeReadFile(file)
    if (content === null) continue
    const id = entry.replace(/\.md$/, '')
    out.push({
      path: `agents/${entry}`,
      kind: 'agent',
      displayName: extractFirstH1(content) ?? id,
      description: extractFirstParagraph(content),
      layer,
      source: root,
    })
  }
  return out
}

async function readSkillsForLayer(layer: IntelligenceLayer, root: string): Promise<Artefact[]> {
  const dir = path.join(root, '.claude', 'skills')
  const entries = await safeReaddir(dir)
  const out: Artefact[] = []
  for (const entry of entries) {
    const file = path.join(dir, entry, 'SKILL.md')
    const content = await safeReadFile(file)
    if (content === null) continue
    out.push({
      path: `.claude/skills/${entry}/SKILL.md`,
      kind: 'skill',
      displayName:
        parseFrontMatterDisplayName(content) ?? extractFirstH1(content) ?? entry,
      description:
        parseFrontMatterDescription(content) ?? extractFirstParagraph(content),
      layer,
      source: root,
    })
  }
  return out
}

async function readMemoryForLayer(layer: IntelligenceLayer, root: string): Promise<Artefact[]> {
  const dir = path.join(root, 'memory')
  const entries = await safeReaddir(dir)
  const out: Artefact[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const file = path.join(dir, entry)
    const content = await safeReadFile(file)
    if (content === null) continue
    out.push({
      path: `memory/${entry}`,
      kind: 'memory',
      displayName: extractFirstH1(content) ?? entry.replace(/\.md$/, ''),
      description: extractFirstParagraph(content),
      layer,
      source: root,
    })
  }
  return out
}

async function readArtefactsForLayer(layer: IntelligenceLayer, root: string): Promise<Artefact[]> {
  const [workflows, agents, skills, memory] = await Promise.all([
    readWorkflowsForLayer(layer, root),
    readAgentsForLayer(layer, root),
    readSkillsForLayer(layer, root),
    readMemoryForLayer(layer, root),
  ])
  return [...workflows, ...agents, ...skills, ...memory]
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

const WRITABLE_LAYERS: ReadonlySet<IntelligenceLayer> = new Set(['tenant', 'repo'])

/**
 * Build the inventory view of every layer the runner can see.
 *
 * Layers are processed in the order supplied. Higher-priority layers win
 * for `replace`-mode artefacts (workflows, agents, skills); the lower-priority
 * occurrences are dropped from the artefact list but counted against the
 * winning entry's `overrides` chain. Memory files are append-mode and
 * therefore listed once per layer that contributes them — we do not collapse
 * memory across layers, since the merged runtime view is the union.
 */
export async function buildIntelligenceCatalogue(
  layerRoots: ReadonlyArray<LayerRoot>,
  logger?: Logger,
): Promise<IntelligenceCatalogue> {
  // Per-kind, per-layer reads in parallel for speed.
  const perLayer = await Promise.all(
    layerRoots.map(async ({ layer, root }) => {
      const exists = root ? await pathExists(root) : false
      const artefacts = exists ? await readArtefactsForLayer(layer, root) : []
      return { layer, root, exists, artefacts }
    }),
  )

  // Apply replace/append merge semantics across the layered artefacts.
  // Iteration order = priority (first wins for replace).
  const seenReplace = new Map<string, Artefact>()
  const memoryArtefacts: Artefact[] = []
  for (const { artefacts } of perLayer) {
    for (const artefact of artefacts) {
      if (artefact.kind === 'memory') {
        memoryArtefacts.push(artefact)
        continue
      }
      const existing = seenReplace.get(artefact.path)
      if (!existing) {
        seenReplace.set(artefact.path, artefact)
      } else if (!existing.overrides) {
        existing.overrides = artefact.layer
      }
    }
  }

  const merged = [...seenReplace.values(), ...memoryArtefacts].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
    return a.displayName.localeCompare(b.displayName)
  })

  // Build the layers panel: counts include every artefact contributed by
  // a layer, regardless of whether it ends up shadowed in the merged view.
  // That gives the user an honest "this layer has N files" number.
  const layers: LayerInfo[] = perLayer.map(({ layer, root, exists, artefacts }) => {
    const counts: Record<ArtefactKind, number> = {
      workflow: 0,
      agent: 0,
      skill: 0,
      memory: 0,
    }
    for (const a of artefacts) counts[a.kind]++
    return {
      layer,
      root,
      exists,
      writable: WRITABLE_LAYERS.has(layer),
      counts,
    }
  })

  logger?.debug?.(
    {
      artefactCount: merged.length,
      layerCounts: layers.map(l => ({ layer: l.layer, total: Object.values(l.counts).reduce((a, b) => a + b, 0) })),
    },
    'Intelligence catalogue built',
  )

  return { layers, artefacts: merged }
}
