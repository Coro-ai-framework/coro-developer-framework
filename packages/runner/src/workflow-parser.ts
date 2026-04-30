import fs from 'fs/promises'
import yaml from 'js-yaml'
import path from 'path'
import { Logger } from 'pino'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SubagentConfig {
  name: string
  agent?: string
  model?: string
  tools?: string[]
}

export interface PhaseConfig {
  name: string
  agent: string | null
  model: 'planning' | 'coding'
  status: string
  subagents?: SubagentConfig[]
  /**
   * Metadata flag surfaced to the dashboard to mark a phase as
    * "developer should approve before advancing". The runner uses this
    * for interactive jobs to park before phase advancement; agents may still
    * call `await_event` explicitly for additional mid-phase questions.
   */
  interactiveCheckpoint?: boolean
  /**
   * Optional whitelist of tool names available to the agent during this
   * phase. When set, replaces the default tool list entirely — the runner
   * passes this straight to `allowedTools` on the Agent SDK query. Use the
   * exact tool names the SDK expects: `Read`, `Write`, `Edit`, `Bash`,
   * `Glob`, `Grep`, `Skill`, `Agent`, and any `mcp__coro__*` patterns.
   *
   * If unset, the runner falls back to the workflow-agnostic defaults
   * (all built-ins + all `mcp__coro__*`).
   */
  tools?: string[]
}

export interface WorkflowConfig {
  initialPhase: string
  initialStatus: string
  phases: PhaseConfig[]
  overrides: Record<string, { initialPhase?: string }>
}

// ── Front matter extraction ───────────────────────────────────────────────────

const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---/

function extractFrontMatter(markdown: string): string | null {
  const match = FRONT_MATTER_RE.exec(markdown)
  return match ? match[1] : null
}

export function stripFrontMatter(markdown: string): string {
  return markdown.replace(FRONT_MATTER_RE, '').trimStart()
}

// ── Raw YAML shape ────────────────────────────────────────────────────────────

interface RawSubagent {
  name?: string
  agent?: string
  model?: string
  tools?: string[]
}

interface RawPhase {
  name?: string
  agent?: string | null
  model?: string
  status?: string
  subagents?: RawSubagent[]
  interactive_checkpoint?: boolean
  tools?: string[]
}

interface RawConfig {
  initial_phase?: string
  initial_status?: string
  phases?: RawPhase[]
  overrides?: Record<string, { initial_phase?: string }>
}

// ── Parser ────────────────────────────────────────────────────────────────────

export function parseWorkflowConfig(markdown: string): WorkflowConfig | null {
  const raw = extractFrontMatter(markdown)
  if (!raw) return null

  let parsed: RawConfig
  try {
    parsed = yaml.load(raw) as RawConfig
  } catch {
    return null
  }

  if (!parsed || !Array.isArray(parsed.phases) || parsed.phases.length === 0) {
    return null
  }

  const phases: PhaseConfig[] = parsed.phases
    .filter((p): p is RawPhase & { name: string } => typeof p.name === 'string')
    .map(p => {
      const phase: PhaseConfig = {
        name: p.name,
        agent: p.agent ?? null,
        model: p.model === 'coding' ? 'coding' : 'planning',
        status: p.status ?? p.name,
      }

      if (p.interactive_checkpoint === true) {
        phase.interactiveCheckpoint = true
      }

      if (Array.isArray(p.tools) && p.tools.length > 0) {
        phase.tools = p.tools.filter((t): t is string => typeof t === 'string')
      }

      if (Array.isArray(p.subagents) && p.subagents.length > 0) {
        phase.subagents = p.subagents
          .filter((sa): sa is RawSubagent & { name: string } => typeof sa.name === 'string')
          .map(sa => ({
            name: sa.name,
            agent: sa.agent,
            model: sa.model,
            tools: sa.tools,
          }))
      }

      return phase
    })

  if (phases.length === 0) return null

  const overrides: WorkflowConfig['overrides'] = {}
  if (parsed.overrides && typeof parsed.overrides === 'object') {
    for (const [key, val] of Object.entries(parsed.overrides)) {
      if (val && typeof val === 'object') {
        overrides[key] = { initialPhase: val.initial_phase }
      }
    }
  }

  return {
    initialPhase: parsed.initial_phase ?? phases[0].name,
    initialStatus: parsed.initial_status ?? 'queued',
    phases,
    overrides,
  }
}

// ── File loader ───────────────────────────────────────────────────────────────

export async function loadWorkflowConfig(
  workflowPath: string,
  coroIntelligenceDir: string,
  logger: Logger,
): Promise<WorkflowConfig | null> {
  const absPath = path.isAbsolute(workflowPath)
    ? workflowPath
    : path.join(coroIntelligenceDir, workflowPath)

  try {
    const content = await fs.readFile(absPath, 'utf-8')
    const config = parseWorkflowConfig(content)
    if (!config) {
      logger.warn({ workflowPath }, 'Workflow file has no valid front matter config')
    }
    return config
  } catch {
    logger.warn({ workflowPath }, 'Could not read workflow file')
    return null
  }
}

/**
 * Resolve a workflow file by searching a list of intelligence roots in
 * order — typically `[coroIntelligenceDir, baseLayerDir]`. Returns the
 * first config that parses successfully, along with the root that
 * resolved it.
 *
 * This mirrors the runtime resolver's layering (tenant overrides base):
 * the tenant overlay's local cache is checked first, falling back to
 * the base layer that ships with `@coro/intelligence-base`. Callers
 * should treat a `null` return as a hard error — there is no legitimate
 * scenario in which a configured workflow is unresolvable.
 *
 * Absolute `workflowPath` values bypass the search and are loaded
 * directly (we still report the originating root as `path.dirname(...)`
 * for diagnostics).
 */
export async function loadWorkflowConfigFromRoots(
  workflowPath: string,
  searchRoots: ReadonlyArray<string>,
  logger: Logger,
): Promise<{ config: WorkflowConfig; resolvedFrom: string } | null> {
  if (!workflowPath) return null

  if (path.isAbsolute(workflowPath)) {
    const config = await loadWorkflowConfig(workflowPath, '', logger)
    return config ? { config, resolvedFrom: path.dirname(workflowPath) } : null
  }

  // Drop falsy/duplicate roots without disturbing order.
  const seen = new Set<string>()
  const roots = searchRoots.filter(r => {
    if (!r || seen.has(r)) return false
    seen.add(r)
    return true
  })

  for (const root of roots) {
    const config = await loadWorkflowConfig(workflowPath, root, logger)
    if (config) {
      logger.debug?.({ workflowPath, resolvedFrom: root }, 'Workflow resolved')
      return { config, resolvedFrom: root }
    }
  }

  return null
}

// ── Lookup helpers ────────────────────────────────────────────────────────────

export function getNextPhase(config: WorkflowConfig, currentPhase: string): string | null {
  const idx = config.phases.findIndex(p => p.name === currentPhase)
  if (idx === -1 || idx === config.phases.length - 1) return null
  return config.phases[idx + 1].name
}

export function getPhaseConfig(config: WorkflowConfig, phaseName: string): PhaseConfig | undefined {
  return config.phases.find(p => p.name === phaseName)
}

export function resolveInitialPhase(config: WorkflowConfig, triggerSource: string): string {
  const override = config.overrides[triggerSource]
  if (override?.initialPhase) return override.initialPhase
  return config.initialPhase
}
