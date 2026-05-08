// ── Workflow Discovery ────────────────────────────────────────────────────────
//
// Walks the layered intelligence stack to enumerate every `workflow.md`
// file the runner can dispatch against. The result drives the dashboard's
// workflow picker on the new-job page so tenants who add a custom
// workflow under `workflows/<my-flow>/workflow.md` see it appear without
// any code change.
//
// Discovery is deliberately separate from `workflow-parser.ts` (which
// extracts the **execution** config: phases, agents, models). Here we only
// care about the metadata needed to *display* and *select* a workflow.
// Front-matter fields read here are all optional; we fall back to the
// directory name and the first H1 heading so existing workflow files
// keep working.

import fs from 'fs/promises'
import path from 'path'
import yaml from 'js-yaml'
import type { Logger } from 'pino'
import { parseWorkflowConfig } from './workflow-parser'

export type WorkflowKind = 'job' | 'campaign' | 'internal'

/**
 * Identifies which intelligence layer an artefact came from. Used by
 * the dashboard to render provenance chips and explain to the developer
 * where they would edit a file to override it.
 */
export type IntelligenceLayer = 'base' | 'tenant' | 'repo'

/** Search-root descriptor used by discovery. Order = priority (first wins). */
export interface LayerRoot {
  layer: IntelligenceLayer
  root: string
}

export interface WorkflowPhaseSummary {
  /** Phase name as declared in the workflow front-matter. */
  name: string
  /** Status string the runner advertises while in this phase. */
  status: string
  /** Agent file the phase runs (e.g. `agents/coder.md`), if any. */
  agent: string | null
  /** Coarse model bucket: `planning` or `coding`. */
  model: 'planning' | 'coding'
  /** Whether the runner pauses for user approval before advancing. */
  interactiveCheckpoint: boolean
  /** Names of subagents this phase may spawn. */
  subagents: string[]
}

export interface DiscoveredWorkflow {
  /** Stable id derived from the directory name (e.g. `job`, `campaign`). */
  id: string
  /** Path relative to its layer root, e.g. `workflows/job/workflow.md`. */
  workflowPath: string
  /** Human-friendly display name. */
  name: string
  /** Short one-liner shown under the name. May be empty. */
  description: string
  /**
   * Coarse classification. `job` means safe to launch from the new-run
   * page; `campaign` is dispatched via its own flow; `internal`
   * workflows are runner-managed (self-update, memory curation) and
   * should never appear in user-facing pickers.
   */
  kind: WorkflowKind
  /** Which intelligence layer this came from (root path). */
  source: string
  /** Logical layer label corresponding to `source`. */
  layer: IntelligenceLayer
  /**
   * If set, the same `workflowPath` also exists in this lower-priority
   * layer — i.e. the current entry is **overriding** the layer named
   * here. Surfaced as a chip in the UI so the user knows their tenant
   * file is shadowing a base file.
   */
  overrides?: IntelligenceLayer
  /**
   * Ordered phase list parsed from the workflow front-matter. Empty if
   * the file has no parseable phases (i.e. malformed YAML).
   */
  phases: WorkflowPhaseSummary[]
  /** First phase the workflow advances to on dispatch. */
  initialPhase: string
}

interface RawFrontMatter {
  display_name?: unknown
  description?: unknown
  kind?: unknown
}

const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---/
const H1_RE = /^#\s+(.+?)\s*$/m

function parseFrontMatter(markdown: string): RawFrontMatter {
  const match = FRONT_MATTER_RE.exec(markdown)
  if (!match) return {}
  try {
    const value = yaml.load(match[1])
    return (value && typeof value === 'object') ? (value as RawFrontMatter) : {}
  } catch {
    return {}
  }
}

function extractFirstH1(markdown: string): string | null {
  // Strip front-matter so we don't accidentally match `# something` inside YAML.
  const body = markdown.replace(FRONT_MATTER_RE, '')
  const match = H1_RE.exec(body)
  if (!match) return null
  // Workflows conventionally title themselves "Workflow: <Display Name>".
  // Strip the prefix when present so we don't show it twice in the UI.
  return match[1].replace(/^workflow:\s*/i, '').trim()
}

function extractFirstParagraph(markdown: string): string {
  const body = markdown.replace(FRONT_MATTER_RE, '').trimStart()
  // Skip the H1 line if present, then take the next non-blank, non-heading paragraph.
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length && (lines[i].startsWith('#') || lines[i].trim() === '')) i++
  const paragraph: string[] = []
  while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('#')) {
    paragraph.push(lines[i].trim())
    i++
  }
  // Cap to keep dashboard rows tidy.
  const collapsed = paragraph.join(' ').replace(/\s+/g, ' ').trim()
  if (collapsed.length <= 220) return collapsed
  return collapsed.slice(0, 217).trimEnd() + '…'
}

function normaliseKind(value: unknown): WorkflowKind {
  if (value === 'campaign' || value === 'internal') return value
  return 'job'
}

async function readWorkflowsFromRoot(layer: IntelligenceLayer, root: string): Promise<DiscoveredWorkflow[]> {
  const workflowsDir = path.join(root, 'workflows')
  let entries: string[]
  try {
    entries = await fs.readdir(workflowsDir)
  } catch {
    return []
  }

  const results: DiscoveredWorkflow[] = []
  for (const entry of entries) {
    const file = path.join(workflowsDir, entry, 'workflow.md')
    let content: string
    try {
      content = await fs.readFile(file, 'utf-8')
    } catch {
      continue
    }
    const fm = parseFrontMatter(content)
    const headingName = extractFirstH1(content)
    const fmName = typeof fm.display_name === 'string' ? fm.display_name.trim() : ''
    const fmDesc = typeof fm.description === 'string' ? fm.description.trim() : ''

    // Reuse the runtime parser so the dashboard sees the exact same phase
    // shape the runner executes — no risk of drift between "what we show"
    // and "what we run".
    const config = parseWorkflowConfig(content)
    const phases: WorkflowPhaseSummary[] = config
      ? config.phases.map(p => ({
          name: p.name,
          status: p.status,
          agent: p.agent,
          model: p.model,
          interactiveCheckpoint: p.interactiveCheckpoint === true,
          subagents: (p.subagents ?? []).map(sa => sa.name),
        }))
      : []
    const initialPhase = config?.initialPhase ?? phases[0]?.name ?? ''

    results.push({
      id: entry,
      workflowPath: `workflows/${entry}/workflow.md`,
      name: fmName || headingName || entry,
      description: fmDesc || extractFirstParagraph(content),
      kind: normaliseKind(fm.kind),
      source: root,
      layer,
      phases,
      initialPhase,
    })
  }
  return results
}

/**
 * Enumerate every workflow visible across the supplied layered roots.
 * Roots are ordered most-specific-first (e.g. tenant before base): the
 * first occurrence of any `workflowPath` wins, and any later layer that
 * also contains that path is recorded on the winning entry as
 * `overrides` so the UI can render the provenance chip.
 */
export async function discoverWorkflows(
  layerRoots: ReadonlyArray<LayerRoot>,
  logger?: Logger,
): Promise<DiscoveredWorkflow[]> {
  const seen = new Map<string, DiscoveredWorkflow>()
  for (const { layer, root } of layerRoots) {
    if (!root) continue
    try {
      const workflows = await readWorkflowsFromRoot(layer, root)
      for (const wf of workflows) {
        const existing = seen.get(wf.workflowPath)
        if (!existing) {
          seen.set(wf.workflowPath, wf)
        } else if (!existing.overrides) {
          // The higher-priority entry is overriding this lower layer.
          // Record only the first lower-layer hit (tenant beats base, repo
          // beats both — deeper conflicts are rare and listing them all
          // would clutter the chip).
          existing.overrides = wf.layer
        }
      }
    } catch (err) {
      logger?.warn?.({ err, root }, 'Workflow discovery failed for root')
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.name.localeCompare(b.name))
}
