// ── Self-improvement tools ───────────────────────────────────────────────────
//
// `propose_change` is the agent's hands. When the Evaluator (or PR
// Reviewer) decides an insight should become a durable change, it
// makes ONE consolidated multi-file call here per target layer. The
// tool then:
//
//   1. routes each file to the right writable layer (tenant or repo)
//      based on `proposals.routing.strategy`,
//   2. validates the file shape per `type` (frontmatter, etc.),
//   3. delegates to the writer module to branch + commit + push,
//   4. opens a PR via the configured provider client,
//   5. records the proposal — including the PR URL — in the state
//      backend so the dashboard / future agents can list pending
//      proposals.
//
// The base layer (`@coro/intelligence-base`) is never writable. Agents
// that try to land changes there get a clean 4xx-equivalent error and
// must redirect to the tenant layer instead.
//
// `list_proposals` reads from the state backend so agents can de-dup
// against pending PRs from this job, prior jobs, or peers in team mode.

import * as path from 'node:path'

import type { ToolContext } from './types'
import {
  defaultWriterCacheRoot,
} from '../config/local-config'
import {
  commitAndPush,
  openProposalPr,
  prepareRepoWriter,
  prepareTenantWriter,
} from '../intelligence/writer'
import { jobReviewers } from '../jobs/types'
import type {
  Proposal,
  ProposalFile,
  ProposalStatus,
  ProposalTargetLayer,
  ProposalType,
} from '../jobs/types'

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * Structured memory-entry schema — preferred over hand-composing markdown
 * when proposing additions to `memory/known-pitfalls.md` or
 * `memory/successful-patterns.md`. The runner serialises each entry into
 * the canonical short-form layout, enforces hard length budgets, and
 * appends to the existing file content.
 *
 * Budgets are deliberately tight; the cost of self-improvement is paid
 * forever by every future job that loads memory, so brevity wins.
 */
export interface MemoryEntryInput {
  /**
   * Which memory file this entry belongs to. Must be inside the
   * tenant `memory/` (or the repo `.coro/memory/`) tree. The runner
   * groups entries by file and appends each group atomically.
   */
  file: string
  /**
   * Entry shape:
   *   - `pitfall`  → ## <title> + Symptom / Root cause / Recipe (≤ 8 lines).
   *   - `pattern`  → ## <title> + When to use / Code skeleton / Anti-pattern (≤ 10 lines).
   */
  kind: 'pitfall' | 'pattern'
  /** Short heading — one line. */
  title: string
  /** One-line description of the surfaced symptom (pitfall) or use case (pattern). */
  symptom?: string
  /** One-line root-cause statement. Pitfalls only. */
  rootCause?: string
  /**
   * Copy-pasteable recipe (pitfall) or code skeleton (pattern).
   * Multi-line allowed; the runner enforces the per-kind budget.
   */
  recipe?: string
  /** One-line anti-pattern note. Patterns only. */
  antiPattern?: string
  /** When to use it. Patterns only. */
  whenToUse?: string
}

export interface ProposeChangeInput {
  type: ProposalType
  title: string
  rationale: string
  description: string
  /**
   * Multi-file payload — preferred. The Evaluator and PR Reviewer
   * should bundle every file change for a single target layer into
   * one call so each (job, layer) produces at most one PR.
   */
  files?: ProposalFile[]
  /**
   * Optional structured memory entries. The runner serialises these
   * into the canonical short-form layout and merges them into `files`
   * (creating or appending to the named files) before validation.
   * Use this for `memory-update` proposals to save prompt tokens and
   * mechanically enforce the per-entry length budgets.
   */
  entries?: MemoryEntryInput[]
  /** Single-file legacy shim. Normalised into `files` if present. */
  targetFile?: string
  proposedContent?: string
  /**
   * Explicit target layer. Optional under the default
   * `proposals.routing.strategy=path` mode (the tool infers it from
   * the path prefix); required under `agent` mode. When supplied,
   * the tool validates that the explicit choice is consistent with
   * the file paths.
   */
  targetLayer?: ProposalTargetLayer
}

export interface ProposeChangeResult {
  proposalId: string
  targetLayer: ProposalTargetLayer
  branch: string
  prUrl: string
  /**
   * Provider-neutral PR id as returned by the writer. Most providers
   * use numeric ids (GitHub / Bitbucket / GitLab) but a string keeps
   * the door open for non-numeric ids (e.g. Linear-style URLs).
   * Consumers needing a numeric form should `Number(prId)` and check
   * `Number.isFinite`.
   */
  prId: string
  filesShipped: string[]
  nextStep: string
}

// ── Path → layer routing ─────────────────────────────────────────────────────

const REPO_PREFIX = '.coro/'

/**
 * Canonical writable paths per layer. Anything outside these prefixes
 * is rejected to keep `propose_change` from acting as an arbitrary
 * file-write primitive.
 */
const TENANT_WRITABLE_PREFIXES = [
  'agents/',
  'workflows/',
  'memory/',
  '.claude/CLAUDE.md',
  '.claude/skills/',
] as const

const REPO_WRITABLE_PREFIXES = [
  '.coro/',
] as const

/**
 * Decide the target layer for a single file according to the
 * configured routing strategy. Throws if:
 *   - the path is outside both layers' writable allowlists, or
 *   - the explicit `targetLayer` (if given) contradicts the path.
 */
export function routeFile(
  filePath: string,
  strategy: 'path' | 'agent',
  explicitLayer: ProposalTargetLayer | undefined,
): ProposalTargetLayer {
  const normalised = filePath.replace(/^\.\//, '')

  if (path.isAbsolute(normalised) || normalised.includes('..')) {
    throw new Error(
      `Invalid proposal path "${filePath}": must be relative and not traverse parent directories.`,
    )
  }

  const isRepoPath = normalised.startsWith(REPO_PREFIX)
  const inferred: ProposalTargetLayer = isRepoPath ? 'repo' : 'tenant'

  if (strategy === 'agent') {
    if (!explicitLayer) {
      throw new Error(
        `proposals.routing.strategy=agent requires an explicit targetLayer in the propose_change call.`,
      )
    }
  }

  if (explicitLayer && explicitLayer !== inferred) {
    throw new Error(
      `Layer mismatch: path "${filePath}" routes to "${inferred}" but targetLayer="${explicitLayer}". ` +
        `Either omit targetLayer (path-based routing will pick "${inferred}") or move the file to a path that matches "${explicitLayer}".`,
    )
  }

  // Final safety check — verify the path is in the allowlist for its
  // layer. We do this last so the user gets the more useful "path
  // routes to X" message above instead of "path is not writable".
  const allowed = inferred === 'repo' ? REPO_WRITABLE_PREFIXES : TENANT_WRITABLE_PREFIXES
  const ok = allowed.some(prefix => normalised === prefix.replace(/\/$/, '') || normalised.startsWith(prefix))
  if (!ok) {
    throw new Error(
      `Path "${filePath}" is not in the writable allowlist for the ${inferred} layer. ` +
        `Permitted prefixes: ${allowed.join(', ')}`,
    )
  }

  return inferred
}

// ── Length budgets for self-improvement output ───────────────────────────────
//
// Memory grows monotonically across the lifetime of a tenant — every
// future job pays the token tax for every line we keep. These caps are
// rules, not suggestions. The numbers come from the plan's Bottleneck 3
// guidance.

export const MEMORY_LENGTH_BUDGETS = {
  pitfall: 8,           // ## title + Symptom + Root cause + Recipe
  pattern: 10,          // ## title + When to use + Code skeleton + Anti-pattern
  skillSection: 15,     // per added section in a skill amendment
} as const

const SKILL_SECTION_RE = /^##\s+/m

/**
 * Best-effort length cap for skill amendments: the runner counts lines
 * per `##` section in any skill file in the proposal payload and rejects
 * sections that exceed the per-section budget. Skill *creates* are not
 * capped (a new skill may legitimately be longer than a single section
 * amendment), but skill *updates* must respect the cap on every section
 * they introduce or modify.
 */
function enforceSkillSectionBudget(file: ProposalFile): void {
  const text = file.content
  // Split by `## ` headings, ignore prologue.
  const sections = text.split(/^##\s+/m).slice(1)
  for (const sec of sections) {
    const heading = sec.split('\n', 1)[0].trim()
    const lineCount = sec.split('\n').length
    if (lineCount > MEMORY_LENGTH_BUDGETS.skillSection) {
      throw new Error(
        `Skill section "${heading}" in "${file.path}" is ${lineCount} lines — exceeds the ` +
          `${MEMORY_LENGTH_BUDGETS.skillSection}-line budget for skill amendments. ` +
          `Tighten the prose or split into a sub-skill before retrying.`,
      )
    }
  }
}

// ── Memory-entry serialisation ───────────────────────────────────────────────
//
// Take the structured entries shipped by the agent and render them in the
// canonical short-form layout. Each kind has a fixed shape so memory stays
// scannable and small.

function renderPitfall(entry: MemoryEntryInput): string {
  const title = (entry.title ?? '').trim() || 'Untitled pitfall'
  const symptom = (entry.symptom ?? '').trim()
  const rootCause = (entry.rootCause ?? '').trim()
  const recipe = (entry.recipe ?? '').trim()

  const lines: string[] = [`## ${title}`]
  if (symptom) lines.push(`- Symptom: ${symptom}`)
  if (rootCause) lines.push(`- Root cause: ${rootCause}`)
  if (recipe) {
    lines.push('- Recipe:')
    for (const line of recipe.split('\n')) lines.push(`    ${line}`)
  }
  return lines.join('\n')
}

function renderPattern(entry: MemoryEntryInput): string {
  const title = (entry.title ?? '').trim() || 'Untitled pattern'
  const whenToUse = (entry.whenToUse ?? '').trim()
  const recipe = (entry.recipe ?? '').trim()
  const antiPattern = (entry.antiPattern ?? '').trim()

  const lines: string[] = [`## ${title}`]
  if (whenToUse) lines.push(`- When to use: ${whenToUse}`)
  if (recipe) {
    lines.push('- Code skeleton:')
    for (const line of recipe.split('\n')) lines.push(`    ${line}`)
  }
  if (antiPattern) lines.push(`- Anti-pattern: ${antiPattern}`)
  return lines.join('\n')
}

/** Render one entry, enforcing the per-kind line budget. */
function renderEntry(entry: MemoryEntryInput): string {
  const rendered = entry.kind === 'pattern' ? renderPattern(entry) : renderPitfall(entry)
  const cap = entry.kind === 'pattern' ? MEMORY_LENGTH_BUDGETS.pattern : MEMORY_LENGTH_BUDGETS.pitfall
  const lineCount = rendered.split('\n').length
  if (lineCount > cap) {
    throw new Error(
      `Memory ${entry.kind} entry "${entry.title}" rendered to ${lineCount} lines — exceeds the ` +
        `${cap}-line budget. Tighten the recipe to a copy-paste minimum, or split into two entries.`,
    )
  }
  return rendered
}

/**
 * Merge structured entries into the proposal's `files[]`. Multiple entries
 * for the same file are concatenated under that file's payload; the runner
 * records the rendered content as the proposed change. Existing inline
 * `files[]` content for the same path takes precedence (the agent can
 * always opt out of structured rendering by supplying raw markdown).
 */
function applyMemoryEntries(
  files: ProposalFile[],
  entries: MemoryEntryInput[] | undefined,
): ProposalFile[] {
  if (!entries || entries.length === 0) return files

  const inlinePaths = new Set(files.map(f => f.path))
  const grouped = new Map<string, string[]>()
  for (const entry of entries) {
    if (!entry.file.startsWith('memory/') && !entry.file.startsWith('.coro/memory/')) {
      throw new Error(
        `Memory entry for "${entry.file}" must live under memory/ (tenant) or .coro/memory/ (repo).`,
      )
    }
    const rendered = renderEntry(entry)
    const bucket = grouped.get(entry.file) ?? []
    bucket.push(rendered)
    grouped.set(entry.file, bucket)
  }

  const out: ProposalFile[] = [...files]
  for (const [filePath, blocks] of grouped) {
    if (inlinePaths.has(filePath)) continue // explicit content wins
    out.push({ path: filePath, content: blocks.join('\n\n') + '\n' })
  }
  return out
}

// ── Per-type format validation ───────────────────────────────────────────────
//
// These checks run inline before we touch git. They are intentionally
// lightweight — they catch the structural mistakes we have actually
// observed (missing skill frontmatter, agent docs without sections)
// rather than re-implementing a markdown linter.

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n/

export function validateProposalFiles(
  type: ProposalType,
  files: ProposalFile[],
): void {
  if (files.length === 0) {
    throw new Error(`propose_change of type "${type}" requires at least one file.`)
  }

  for (const f of files) {
    if (!f.content || f.content.trim().length === 0) {
      throw new Error(`File "${f.path}" has empty content.`)
    }
  }

  switch (type) {
    case 'skill-create':
    case 'skill-update': {
      for (const f of files) {
        if (!f.path.startsWith('.claude/skills/')) {
          throw new Error(
            `Skill files must live under .claude/skills/, but "${f.path}" does not. ` +
              `If this is a different kind of change, choose a different proposal type.`,
          )
        }
        // SKILL.md must have YAML frontmatter with `name` and `description`.
        if (f.path.endsWith('SKILL.md')) {
          const m = FRONTMATTER_RE.exec(f.content)
          if (!m) {
            throw new Error(
              `Skill file "${f.path}" must start with YAML frontmatter (--- name: ... description: ... ---).`,
            )
          }
          const fm = m[1]
          if (!/^\s*name\s*:\s*\S+/m.test(fm)) {
            throw new Error(`Skill file "${f.path}" frontmatter is missing a non-empty "name".`)
          }
          if (!/^\s*description\s*:\s*\S+/m.test(fm)) {
            throw new Error(`Skill file "${f.path}" frontmatter is missing a non-empty "description".`)
          }
        }
      }
      // Skill amendments must respect the per-section line budget.
      // skill-create skips this — a brand-new skill may be larger.
      if (type === 'skill-update' && SKILL_SECTION_RE.test(files.map(f => f.content).join('\n'))) {
        for (const f of files) {
          if (f.path.endsWith('SKILL.md')) enforceSkillSectionBudget(f)
        }
      }
      break
    }

    case 'claude-md-update': {
      const violator = files.find(f => !f.path.endsWith('.claude/CLAUDE.md') && !f.path.endsWith('CLAUDE.md'))
      if (violator) {
        throw new Error(
          `claude-md-update proposals may only touch .claude/CLAUDE.md, but "${violator.path}" does not match.`,
        )
      }
      break
    }

    case 'new-agent':
    case 'modify-agent': {
      for (const f of files) {
        if (!f.path.startsWith('agents/') || !f.path.endsWith('.md')) {
          throw new Error(`Agent file "${f.path}" must live under agents/ and end with .md.`)
        }
        if (!/^#\s+/m.test(f.content)) {
          throw new Error(`Agent file "${f.path}" should start with a top-level heading.`)
        }
      }
      break
    }

    case 'new-workflow':
    case 'modify-workflow': {
      for (const f of files) {
        if (!f.path.startsWith('workflows/')) {
          throw new Error(`Workflow file "${f.path}" must live under workflows/.`)
        }
      }
      break
    }

    case 'memory-update': {
      for (const f of files) {
        if (!f.path.startsWith('memory/') && !f.path.startsWith('.coro/memory/')) {
          throw new Error(`Memory file "${f.path}" must live under memory/ (tenant) or .coro/memory/ (repo).`)
        }
      }
      break
    }

    case 'new-tool':
    case 'modify-tool': {
      // Tool changes don't have a fixed layout — they typically span
      // multiple files (skill + tests + docs). We trust the
      // path-routing allowlist to keep them inside writable areas.
      break
    }
  }
}

// ── proposeChange ────────────────────────────────────────────────────────────

/**
 * Ship a self-improvement proposal as a PR against the tenant
 * intelligence repo or the project repo's `.coro/` overlay.
 *
 * Single tool call → single PR. The Evaluator (and PR Reviewer)
 * MUST bundle every file change for a given target layer into one
 * call — splitting produces multiple PRs and duplicate review work.
 *
 * Returns a structured result the agent can include in its phase
 * artefact / forward to the dashboard. Throws on validation failures
 * so the agent can correct and retry rather than discovering the
 * problem from a half-pushed branch.
 */
export async function proposeChange(
  input: ProposeChangeInput,
  ctx: ToolContext,
): Promise<ProposeChangeResult> {
  const files = applyMemoryEntries(normaliseFiles(input), input.entries)
  validateProposalFiles(input.type, files)

  const strategy = ctx.settings.proposals.routing.strategy
  // Route every file. If they disagree, we cannot ship them together.
  const layers = files.map(f => routeFile(f.path, strategy, input.targetLayer))
  const targetLayer = layers[0]
  if (!layers.every(l => l === targetLayer)) {
    throw new Error(
      `All files in a single propose_change call must target the same layer. ` +
        `Got mixed: ${files.map((f, i) => `${f.path}=${layers[i]}`).join(', ')}. ` +
        `Make one call per layer.`,
    )
  }

  // Runtime constraint: at most one proposal per (jobId, layer). The plan
  // calls for the runner to reject duplicate bundles so the agent cannot
  // accidentally split a knowledge update into multiple PRs. Reject when a
  // prior proposal exists for the same job + layer regardless of its
  // terminal status — once the agent has shipped its bundle for a layer,
  // the cycle is closed for this job.
  const existing = await ctx.stateBackend.listProposals(ctx.tenantContext.tenantId)
  const dupe = existing.find(
    p => p.jobId === ctx.job.id && p.targetLayer === targetLayer,
  )
  if (dupe) {
    throw new Error(
      `propose_change already shipped for this job + layer ` +
        `(proposal ${dupe.id}, branch ${dupe.branch ?? '<unknown>'}, PR ${dupe.prUrl ?? '<unknown>'}, status ${dupe.status}). ` +
        `Bundle every file change for the ${targetLayer} layer into ONE propose_change call. ` +
        `If you need to amend, push to the existing branch by hand instead of opening a second PR.`,
    )
  }

  // Prepare the writer's working tree.
  const writerCacheRoot = defaultWriterCacheRoot()
  let writerDir: string
  let baseRef: string
  let remoteUrl: string

  if (targetLayer === 'tenant') {
    const overlay = ctx.tenantContext.overlay
    if (overlay.kind !== 'gitRemote' || !overlay.url) {
      throw new Error(
        `Cannot ship a tenant-layer proposal: the tenant overlay must be a git remote (currently: ${overlay.kind}). ` +
          `Set intelligence.gitRemote in ~/.coro/config.json (dashboard: Settings → Paths → Intelligence Git Remote), ` +
          `or set tenant.overlay to { kind: "gitRemote", url: "<repo>" }. Local-dir overlays cannot open PRs.`,
      )
    }
    const writer = await prepareTenantWriter({
      url: overlay.url,
      ref: overlay.ref,
      tenantId: ctx.tenantContext.tenantId,
      writerCacheRoot,
      logger: ctx.logger,
    })
    writerDir = writer.dir
    baseRef = writer.baseRef
    remoteUrl = writer.remoteUrl
  } else {
    const repoCheckoutDir = deriveRepoCheckoutDir(ctx)
    if (!repoCheckoutDir) {
      throw new Error(
        `Cannot ship a repo-layer proposal: the active job has no repoSlug param so the runner cannot ` +
          `locate the target repo. Set job.params.repoSlug or move the change to the tenant layer.`,
      )
    }
    const writer = await prepareRepoWriter({ repoCheckoutDir, logger: ctx.logger })
    writerDir = writer.dir
    baseRef = writer.baseRef
    remoteUrl = writer.remoteUrl
  }

  // Branch + commit + push.
  const slug = toSlug(input.title)
  const branch = `coro/proposal/${ctx.job.id}-${targetLayer}-${slug}`.slice(0, 200)
  const commitMessage = buildCommitMessage(input, targetLayer)

  await commitAndPush({
    dir: writerDir,
    branch,
    baseRef,
    files,
    commitMessage,
    logger: ctx.logger,
  })

  // Open the PR via the SCM plugin matching the remote. The writer
  // never reaches into bare BitBucket / GitHub clients anymore — see
  // `intelligence/writer.ts:openProposalPr` for the dispatch rules.
  const reviewerUsernames = jobReviewers(ctx.job)
  const pr = await openProposalPr({
    remoteUrl,
    branch,
    baseRef,
    title: `Coro proposal: ${input.title}`,
    body: buildPrBody(input, files, targetLayer, ctx),
    ...(reviewerUsernames.length > 0 ? { reviewerUsernames } : {}),
    plugins: ctx.plugins,
    logger: ctx.logger,
  })

  // Record in the state backend so the dashboard and future jobs can
  // de-dup. The runner intentionally writes the proposal *after* the
  // PR opens — if PR creation fails the state stays clean.
  //
  // The writer's `OpenedProposalPr.id` is a provider-neutral string
  // post-pivot (some providers — e.g. Linear — use non-numeric ids).
  // The legacy `Proposal.prId` column is still typed `number | null`
  // for back-compat; we coerce when the id is purely numeric and
  // fall through to `null` otherwise so the dashboard's existing
  // numeric-PR queries keep working without lying about non-numeric
  // ids.
  const now = new Date().toISOString()
  const numericPrId = /^\d+$/.test(pr.id) ? Number(pr.id) : null
  const stored = await ctx.stateBackend.createProposal({
    tenantId: ctx.tenantContext.tenantId,
    jobId: ctx.job.id,
    type: input.type,
    title: input.title,
    rationale: input.rationale,
    description: input.description,
    status: 'pending',
    files,
    createdAt: now,
    updatedAt: now,
    targetLayer,
    branch,
    prUrl: pr.url,
    prId: numericPrId,
  })

  await ctx.stateBackend.appendLog(
    ctx.job.id,
    `[propose_change] Opened ${pr.provider} PR #${pr.id} for "${input.title}" (${targetLayer}, ${files.length} file(s)) — ${pr.url}`,
  )
  ctx.logger.info(
    {
      jobId: ctx.job.id,
      proposalId: stored.id,
      type: input.type,
      targetLayer,
      branch,
      prId: pr.id,
      prUrl: pr.url,
      fileCount: files.length,
    },
    'Proposal shipped',
  )

  return {
    proposalId: stored.id,
    targetLayer,
    branch,
    prUrl: pr.url,
    prId: pr.id,
    filesShipped: files.map(f => f.path),
    nextStep: `PR opened against the ${targetLayer} repo. A human must review and merge it for the change to take effect.`,
  }
}

// ── listProposals ────────────────────────────────────────────────────────────

export interface ListProposalsInput {
  limit?: number
  type?: string
  /** Optional filter by status; defaults to all. */
  status?: ProposalStatus
}

/**
 * List proposals for the current tenant. Reads from the state backend
 * (no more on-disk markdown scan). Agents call this before proposing
 * to avoid duplicating an in-flight proposal from the same job, an
 * earlier job, or — in team mode — a peer.
 */
export async function listProposals(
  input: ListProposalsInput,
  ctx: ToolContext,
): Promise<{ proposals: ProposalSummary[]; count: number; totalForTenant: number }> {
  const all = await ctx.stateBackend.listProposals(ctx.tenantContext.tenantId, input.status)
  const filtered = input.type ? all.filter(p => p.type === input.type) : all
  const limit = input.limit ?? 20
  const sliced = filtered.slice(0, limit)

  return {
    proposals: sliced.map(toSummary),
    count: sliced.length,
    totalForTenant: all.length,
  }
}

interface ProposalSummary {
  id: string
  type: ProposalType
  title: string
  status: ProposalStatus
  targetLayer?: ProposalTargetLayer
  prUrl?: string | null
  branch?: string
  rationalePreview: string
  fileCount: number
  createdAt: string
  jobId: string
}

function toSummary(p: Proposal): ProposalSummary {
  return {
    id: p.id,
    type: p.type,
    title: p.title,
    status: p.status,
    ...(p.targetLayer ? { targetLayer: p.targetLayer } : {}),
    ...(p.prUrl !== undefined ? { prUrl: p.prUrl } : {}),
    ...(p.branch ? { branch: p.branch } : {}),
    rationalePreview: p.rationale.length > 240 ? `${p.rationale.slice(0, 240)}…` : p.rationale,
    fileCount: p.files?.length ?? 0,
    createdAt: p.createdAt,
    jobId: p.jobId,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normaliseFiles(input: ProposeChangeInput): ProposalFile[] {
  const out: ProposalFile[] = [...(input.files ?? [])]
  if (input.targetFile && input.proposedContent !== undefined) {
    out.push({ path: input.targetFile, content: input.proposedContent })
  }
  return out
}

function toSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'proposal'
}

function deriveRepoCheckoutDir(ctx: ToolContext): string | undefined {
  const slug = ctx.job.params['repoSlug']
  if (typeof slug !== 'string' || slug.length === 0) return undefined
  return path.join(ctx.settings.paths.workingDir, ctx.job.id, slug)
}

function buildCommitMessage(input: ProposeChangeInput, targetLayer: ProposalTargetLayer): string {
  const subject = `Coro proposal (${targetLayer}): ${input.title}`
  return `${subject}\n\n${input.rationale}\n\nType: ${input.type}\n`
}

function buildPrBody(
  input: ProposeChangeInput,
  files: ProposalFile[],
  targetLayer: ProposalTargetLayer,
  ctx: ToolContext,
): string {
  const lines: string[] = []
  lines.push(`**Proposed by:** \`${ctx.job.id}\` (phase: ${ctx.job.phase})`)
  lines.push(`**Type:** \`${input.type}\``)
  lines.push(`**Target layer:** \`${targetLayer}\``)
  lines.push(`**Files (${files.length}):**`)
  for (const f of files) lines.push(`- \`${f.path}\``)
  lines.push('')
  lines.push('## Rationale')
  lines.push('')
  lines.push(input.rationale)
  lines.push('')
  lines.push('## Description')
  lines.push('')
  lines.push(input.description)
  lines.push('')
  lines.push('---')
  lines.push('_Filed automatically by Coro. Review and merge to apply._')
  return lines.join('\n')
}
