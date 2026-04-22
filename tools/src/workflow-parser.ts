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
   * When true AND the job is in interactive mode, the runner parks at the end
   * of this phase waiting for developer approval before advancing.
   */
  interactiveCheckpoint?: boolean
  /** @deprecated No longer consumed by the builder — knowledge is now loaded on-demand via skills. Kept for parser backward compatibility. */
  knowledge?: string[]
  /** @deprecated No longer consumed by the builder — conventions are now loaded on-demand via skills. Kept for parser backward compatibility. */
  conventions?: string[]
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
  knowledge?: string[]
  conventions?: string[]
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

      if (Array.isArray(p.knowledge) && p.knowledge.length > 0) {
        phase.knowledge = p.knowledge
      }

      if (Array.isArray(p.conventions) && p.conventions.length > 0) {
        phase.conventions = p.conventions
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
  a5aiDir: string,
  logger: Logger,
): Promise<WorkflowConfig | null> {
  const absPath = path.isAbsolute(workflowPath)
    ? workflowPath
    : path.join(a5aiDir, workflowPath)

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
