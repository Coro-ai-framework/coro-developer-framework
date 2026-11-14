import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { z } from 'zod'
import { PACKAGE_ROOT, resolvePath, shortHash } from './util'

/**
 * A scenario is everything about *how Coro is run* that a person may want to
 * vary between runs: which lane, which models, which intelligence overlay, how
 * many attempts. Tasks say what to do; the scenario says how Coro does it.
 *
 * Scenarios are strict: an unknown key is an error, so a typo in `--set`
 * (`--set lanee=fast`) fails loudly instead of quietly running the baseline.
 */

/** Different from Coro's default coding model on purpose; override with `--set judge.model=...`. */
export const DEFAULT_JUDGE_MODEL = 'claude-opus-5-5'

export const LANES = ['standard', 'fast', 'deep'] as const
export type Lane = (typeof LANES)[number]

const judgeSchema = z
  .object({
    enabled: z.boolean().default(true),
    provider: z.literal('anthropic').default('anthropic'),
    model: z.string().min(1).default(DEFAULT_JUDGE_MODEL),
    /** Independent judge passes per attempt; scores are medianed, issues need a majority. */
    samples: z.number().int().min(1).max(9).default(1),
  })
  .strict()

const reviewerSchema = z
  .object({
    /** How long the simulated reviewer waits after a job parks on a PR before approving. */
    approveAfterSeconds: z.number().min(0).default(0),
  })
  .strict()

export const scenarioSchema = z
  .object({
    /** Coro checkout to run. Relative paths resolve against packages/eval; must already be built. */
    coroPath: z.string().min(1).default('../..'),
    lane: z.enum(LANES).default('standard'),
    /**
     * Model per tier, e.g. `{ coding: 'claude-sonnet-5-5' }`. Written into the
     * runner's `llm.aliases` for both `<tier>` and `tier:<tier>`.
     */
    models: z.record(z.string().regex(/^[A-Za-z][\w:.-]*$/), z.string().min(1)).default({}),
    /** A `localDir` tenant overlay, to A/B a change to intelligence markdown. */
    tenantOverlayDir: z.string().min(1).nullable().default(null),
    /** Written to the runner's `codeReview.lenses`. */
    codeReviewLenses: z.boolean().default(true),
    /** Attempts per task. */
    repeat: z.number().int().min(1).default(3),
    /** Attempts in flight at once; each gets its own runner process. */
    parallel: z.number().int().min(1).default(2),
    judge: judgeSchema.prefault({}),
    reviewer: reviewerSchema.prefault({}),
    /** How often the harness polls `GET /jobs/:id`. */
    pollIntervalSeconds: z.number().positive().default(5),
    /** How long to wait for the runner's `/health` after spawning it. */
    startupTimeoutSeconds: z.number().positive().default(90),
  })
  .strict()

export type Scenario = z.infer<typeof scenarioSchema>

/** Fields that do not change what Coro does, so they are left out of the scenario hash. */
const HASH_EXCLUDED: ReadonlyArray<keyof Scenario> = [
  'repeat',
  'parallel',
  'reviewer',
  'pollIntervalSeconds',
  'startupTimeoutSeconds',
]

export function scenarioHash(scenario: Scenario): string {
  const hashed: Record<string, unknown> = { ...scenario }
  for (const key of HASH_EXCLUDED) delete hashed[key]
  return shortHash(hashed)
}

// ── --set overrides ──────────────────────────────────────────────────────────

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export interface ParsedOverride {
  path: string[]
  value: unknown
}

/**
 * Parse `dotted.key=value`. The value is read as JSON when it is valid JSON
 * (`5`, `true`, `null`, `["a"]`) and as a plain string otherwise
 * (`claude-sonnet-5-5`, `/abs/path`).
 */
export function parseOverride(expr: string): ParsedOverride {
  const eq = expr.indexOf('=')
  if (eq <= 0) throw new Error(`--set expects key=value, got "${expr}"`)
  const key = expr.slice(0, eq).trim()
  const raw = expr.slice(eq + 1)
  const segments = key.split('.')
  if (segments.some(s => s.length === 0)) throw new Error(`--set key "${key}" has an empty segment`)
  for (const segment of segments) {
    if (FORBIDDEN_KEYS.has(segment)) throw new Error(`--set key "${key}" is not allowed`)
  }
  let value: unknown = raw
  try {
    value = JSON.parse(raw)
  } catch {
    // not JSON: keep the string
  }
  return { path: segments, value }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Apply overrides to a deep copy of `base`. Later overrides win. */
export function applyOverrides(
  base: Record<string, unknown>,
  expressions: readonly string[],
): Record<string, unknown> {
  const result = structuredClone(base)
  for (const expr of expressions) {
    const { path: segments, value } = parseOverride(expr)
    let cursor = result
    for (const segment of segments.slice(0, -1)) {
      const next = cursor[segment]
      if (isPlainObject(next)) {
        cursor = next
      } else {
        const created: Record<string, unknown> = {}
        cursor[segment] = created
        cursor = created
      }
    }
    cursor[segments[segments.length - 1]!] = value
  }
  return result
}

// ── Loading ──────────────────────────────────────────────────────────────────

export const SCENARIOS_DIR = path.join(PACKAGE_ROOT, 'scenarios')

const SCENARIO_EXTENSIONS = ['.yaml', '.yml', '.json']

/** `baseline` -> scenarios/baseline.yaml; an existing path is used as given. */
export function findScenarioFile(nameOrPath: string, scenariosDir: string = SCENARIOS_DIR): string {
  const looksLikePath = nameOrPath.includes('/') || SCENARIO_EXTENSIONS.some(ext => nameOrPath.endsWith(ext))
  if (looksLikePath) {
    for (const candidate of [path.resolve(nameOrPath), path.resolve(PACKAGE_ROOT, nameOrPath)]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    }
    throw new Error(`Scenario file not found: ${nameOrPath}`)
  }
  for (const ext of SCENARIO_EXTENSIONS) {
    const candidate = path.join(scenariosDir, `${nameOrPath}${ext}`)
    if (fs.existsSync(candidate)) return candidate
  }
  const available = listScenarios(scenariosDir)
  throw new Error(
    `Scenario "${nameOrPath}" not found in ${scenariosDir}` +
      (available.length ? ` (available: ${available.join(', ')})` : ''),
  )
}

export function listScenarios(scenariosDir: string = SCENARIOS_DIR): string[] {
  if (!fs.existsSync(scenariosDir)) return []
  return fs
    .readdirSync(scenariosDir)
    .filter(name => SCENARIO_EXTENSIONS.some(ext => name.endsWith(ext)))
    .map(name => path.basename(name, path.extname(name)))
    .sort()
}

export function readScenarioFile(file: string): Record<string, unknown> {
  const text = fs.readFileSync(file, 'utf-8')
  const parsed = file.endsWith('.json') ? JSON.parse(text) : yaml.load(text)
  if (parsed === null || parsed === undefined) return {}
  if (!isPlainObject(parsed)) throw new Error(`Scenario ${file} must be a mapping at the top level`)
  return parsed
}

export interface ResolveScenarioInput {
  /** Raw scenario values (from a file); defaults fill the rest. */
  base?: Record<string, unknown>
  /** Values from dedicated CLI flags (`--repeat`, `--parallel`); applied over `base`. */
  flags?: Record<string, unknown>
  /** `--set key=value` expressions; applied last, so they win. */
  overrides?: readonly string[]
}

export function resolveScenario(input: ResolveScenarioInput = {}): Scenario {
  const withFlags = { ...(input.base ?? {}) }
  for (const [key, value] of Object.entries(input.flags ?? {})) {
    if (value !== undefined) withFlags[key] = value
  }
  const merged = applyOverrides(withFlags, input.overrides ?? [])
  const parsed = scenarioSchema.safeParse(merged)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`Invalid scenario:\n${issues}`)
  }
  return parsed.data
}

export function loadScenario(
  nameOrPath: string,
  input: Omit<ResolveScenarioInput, 'base'> = {},
  scenariosDir: string = SCENARIOS_DIR,
): { scenario: Scenario; file: string } {
  const file = findScenarioFile(nameOrPath, scenariosDir)
  return { scenario: resolveScenario({ ...input, base: readScenarioFile(file) }), file }
}

// ── Derived values ───────────────────────────────────────────────────────────

/** The workflow a lane dispatches. Mirrors Coro's `.claude/commands/coro/job*.md` convention. */
export function laneWorkflowPath(lane: Lane): string {
  const slug = lane === 'standard' ? 'job' : `job-${lane}`
  return `.claude/commands/coro/${slug}.md`
}

export function resolveCoroPath(scenario: Scenario): string {
  return resolvePath(scenario.coroPath)
}
