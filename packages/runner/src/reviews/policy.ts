// ── Review policy ────────────────────────────────────────────────────────────
//
// Resolved once per round and stored on the job, so a round cannot widen
// its own authority. Merge order: defaults < tenant < user (or CI) < repo.
// The repo layer can only tighten.

import { PR_REVIEW_WORKFLOW_PATH } from '@coro-ai/cloud-protocol'

export type ReviewAutonomy = 'draft' | 'comment' | 'full'
export type ReviewApproval = 'never' | 'recommend' | 'auto'
export type ReviewSeverity = 'blocker' | 'major' | 'minor' | 'nit'
export type LearnOnClose = 'off' | 'deterministic' | 'llm'

export interface ReviewMcpRole {
  servers: string[]
  allowTools: string[]
  denyTools: string[]
}

export interface ReviewReference {
  name: string
  url: string
  ref?: string
  paths?: string[]
  purpose: string
  refreshMin?: number
}

export interface ContractChecker {
  glob: string
  command: string
}

export interface ReviewPolicy {
  enabled: boolean
  scms: string[]
  identity: 'self' | 'bot'
  eventSource: 'poll' | 'webhook' | 'both'
  inboxIntervalSec: number
  includeTeams: boolean
  activityIntervalSec: number
  reposInclude: string[]
  reposExclude: string[]
  skipDrafts: boolean
  skipAuthors: string[]
  autonomy: ReviewAutonomy
  approval: ReviewApproval
  /** Park each round with its draft until a developer approves what gets posted. */
  approveBeforePosting: boolean
  minSeverity: ReviewSeverity
  maxCommentsPerRound: number
  maxDiffLines: number
  debounceSec: number
  maxRounds: number
  maxConcurrentRounds: number
  maxParallelLenses: number
  budgetUsdPerPr: number
  budgetUsdPerDay: number
  maxLensInputTokens: number
  learnOnClose: LearnOnClose
  allowCodeExecution: boolean
  workflowPath: string
  mcpRoles: Record<string, ReviewMcpRole>
  references: ReviewReference[]
  contractCheckers: ContractChecker[]
  briefTtlHours: number
  /** Lens names the repo (or user) kept. Empty means "all declared lenses". */
  lenses: string[]
  ignorePaths: string[]
  architectureSources: string[]
}

const SEVERITY_RANK: Record<ReviewSeverity, number> = {
  nit: 0,
  minor: 1,
  major: 2,
  blocker: 3,
}

const AUTONOMY_RANK: Record<ReviewAutonomy, number> = { draft: 0, comment: 1, full: 2 }
const APPROVAL_RANK: Record<ReviewApproval, number> = { never: 0, recommend: 1, auto: 2 }

export const REVIEW_POLICY_DEFAULTS: ReviewPolicy = {
  enabled: false,
  scms: ['github'],
  identity: 'self',
  eventSource: 'poll',
  inboxIntervalSec: 120,
  includeTeams: true,
  activityIntervalSec: 60,
  reposInclude: [],
  reposExclude: [],
  skipDrafts: true,
  skipAuthors: ['dependabot[bot]', 'renovate[bot]'],
  autonomy: 'comment',
  approval: 'recommend',
  approveBeforePosting: false,
  minSeverity: 'minor',
  maxCommentsPerRound: 15,
  maxDiffLines: 4000,
  debounceSec: 180,
  maxRounds: 25,
  maxConcurrentRounds: 2,
  maxParallelLenses: 4,
  budgetUsdPerPr: 5,
  budgetUsdPerDay: 25,
  maxLensInputTokens: 120_000,
  learnOnClose: 'deterministic',
  allowCodeExecution: false,
  workflowPath: PR_REVIEW_WORKFLOW_PATH,
  mcpRoles: {},
  references: [],
  contractCheckers: [],
  briefTtlHours: 24,
  lenses: [],
  ignorePaths: [],
  architectureSources: ['docs/adr/**', 'docs/architecture/**', 'ARCHITECTURE.md', 'CODEOWNERS'],
}

export interface ReviewPolicyLayers {
  tenant?: Partial<ReviewPolicy>
  user?: Partial<ReviewPolicy>
  /** Repo `.coro/review.md` front matter. Tightens only. */
  repo?: Partial<ReviewPolicy>
  ci?: Partial<ReviewPolicy>
}

/** Map the `reviews` block in `~/.coro/config.json` onto a policy patch. */
export function reviewsConfigToPolicy(raw: {
  enabled?: boolean
  scms?: string[]
  identity?: ReviewPolicy['identity']
  eventSource?: ReviewPolicy['eventSource']
  inbox?: { intervalSec?: number; includeTeams?: boolean }
  activity?: { intervalSec?: number }
  repos?: { include?: string[]; exclude?: string[] }
  skipDrafts?: boolean
  skipAuthors?: string[]
  autonomy?: ReviewAutonomy
  approval?: ReviewApproval
  approveBeforePosting?: boolean
  minSeverity?: ReviewSeverity
  maxCommentsPerRound?: number
  maxDiffLines?: number
  debounceSec?: number
  maxRounds?: number
  maxConcurrentRounds?: number
  maxParallelLenses?: number
  budgetUsdPerPr?: number
  budgetUsdPerDay?: number
  maxLensInputTokens?: number
  learnOnClose?: LearnOnClose
  allowCodeExecution?: boolean
  workflowPath?: string
  mcpRoles?: Record<string, { servers: string[]; allowTools?: string[]; denyTools?: string[] }>
  references?: ReviewReference[]
  contractCheckers?: ContractChecker[]
  briefTtlHours?: number
} | undefined): ReviewPolicy {
  if (!raw) return resolveReviewPolicy()
  const user: Partial<ReviewPolicy> = {}
  if (raw.enabled !== undefined) user.enabled = raw.enabled
  if (raw.scms) user.scms = raw.scms
  if (raw.identity) user.identity = raw.identity
  if (raw.eventSource) user.eventSource = raw.eventSource
  if (raw.inbox?.intervalSec !== undefined) user.inboxIntervalSec = raw.inbox.intervalSec
  if (raw.inbox?.includeTeams !== undefined) user.includeTeams = raw.inbox.includeTeams
  if (raw.activity?.intervalSec !== undefined) user.activityIntervalSec = raw.activity.intervalSec
  if (raw.repos?.include) user.reposInclude = raw.repos.include
  if (raw.repos?.exclude) user.reposExclude = raw.repos.exclude
  if (raw.skipDrafts !== undefined) user.skipDrafts = raw.skipDrafts
  if (raw.skipAuthors) user.skipAuthors = raw.skipAuthors
  if (raw.autonomy) user.autonomy = raw.autonomy
  if (raw.approval) user.approval = raw.approval
  if (raw.approveBeforePosting !== undefined) user.approveBeforePosting = raw.approveBeforePosting
  if (raw.minSeverity) user.minSeverity = raw.minSeverity
  if (raw.maxCommentsPerRound !== undefined) user.maxCommentsPerRound = raw.maxCommentsPerRound
  if (raw.maxDiffLines !== undefined) user.maxDiffLines = raw.maxDiffLines
  if (raw.debounceSec !== undefined) user.debounceSec = raw.debounceSec
  if (raw.maxRounds !== undefined) user.maxRounds = raw.maxRounds
  if (raw.maxConcurrentRounds !== undefined) user.maxConcurrentRounds = raw.maxConcurrentRounds
  if (raw.maxParallelLenses !== undefined) user.maxParallelLenses = raw.maxParallelLenses
  if (raw.budgetUsdPerPr !== undefined) user.budgetUsdPerPr = raw.budgetUsdPerPr
  if (raw.budgetUsdPerDay !== undefined) user.budgetUsdPerDay = raw.budgetUsdPerDay
  if (raw.maxLensInputTokens !== undefined) user.maxLensInputTokens = raw.maxLensInputTokens
  if (raw.learnOnClose) user.learnOnClose = raw.learnOnClose
  if (raw.allowCodeExecution !== undefined) user.allowCodeExecution = raw.allowCodeExecution
  if (raw.workflowPath) user.workflowPath = raw.workflowPath
  if (raw.mcpRoles) {
    user.mcpRoles = Object.fromEntries(Object.entries(raw.mcpRoles).map(([name, role]) => [name, {
      servers: role.servers,
      allowTools: role.allowTools ?? [],
      denyTools: role.denyTools ?? [],
    }]))
  }
  if (raw.references) user.references = raw.references
  if (raw.contractCheckers) user.contractCheckers = raw.contractCheckers
  if (raw.briefTtlHours !== undefined) user.briefTtlHours = raw.briefTtlHours
  return resolveReviewPolicy({ user })
}

export function resolveReviewPolicy(layers: ReviewPolicyLayers = {}): ReviewPolicy {
  const base = { ...REVIEW_POLICY_DEFAULTS }
  applyWidenable(base, layers.tenant)
  applyWidenable(base, layers.user)
  applyWidenable(base, layers.ci)
  applyTighten(base, layers.repo)
  return base
}

/** Apply a repo's `.coro/review.md` to an already-resolved policy. Tighten-only. */
export function tightenPolicy(policy: ReviewPolicy, repo: Partial<ReviewPolicy>): ReviewPolicy {
  const next = structuredClone(policy)
  applyTighten(next, repo)
  return next
}

function applyWidenable(target: ReviewPolicy, patch?: Partial<ReviewPolicy>): void {
  if (!patch) return
  const keys = Object.keys(patch) as (keyof ReviewPolicy)[]
  for (const key of keys) {
    const value = patch[key]
    if (value === undefined) continue
    // A repo is the only layer that must not add resources. User and
    // tenant may. `allowCodeExecution` is user-level only; a tenant
    // patch is still accepted here because the caller decides which
    // layer is which, and CI is treated as the user.
    assign(target, key, value)
  }
}

function applyTighten(target: ReviewPolicy, repo?: Partial<ReviewPolicy>): void {
  if (!repo) return
  if (repo.minSeverity && SEVERITY_RANK[repo.minSeverity] > SEVERITY_RANK[target.minSeverity]) {
    target.minSeverity = repo.minSeverity
  }
  if (typeof repo.maxCommentsPerRound === 'number') {
    target.maxCommentsPerRound = Math.min(target.maxCommentsPerRound, repo.maxCommentsPerRound)
  }
  if (typeof repo.maxDiffLines === 'number') {
    target.maxDiffLines = Math.min(target.maxDiffLines, repo.maxDiffLines)
  }
  if (typeof repo.maxRounds === 'number') {
    target.maxRounds = Math.min(target.maxRounds, repo.maxRounds)
  }
  if (typeof repo.budgetUsdPerPr === 'number') {
    target.budgetUsdPerPr = Math.min(target.budgetUsdPerPr, repo.budgetUsdPerPr)
  }
  if (typeof repo.budgetUsdPerDay === 'number') {
    target.budgetUsdPerDay = Math.min(target.budgetUsdPerDay, repo.budgetUsdPerDay)
  }
  if (repo.autonomy && AUTONOMY_RANK[repo.autonomy] < AUTONOMY_RANK[target.autonomy]) {
    target.autonomy = repo.autonomy
  }
  if (repo.approval && APPROVAL_RANK[repo.approval] < APPROVAL_RANK[target.approval]) {
    target.approval = repo.approval
  }
  if (repo.skipDrafts === true) target.skipDrafts = true
  if (repo.approveBeforePosting === true) target.approveBeforePosting = true
  if (repo.ignorePaths?.length) {
    target.ignorePaths = [...new Set([...target.ignorePaths, ...repo.ignorePaths])]
  }
  if (repo.lenses?.length) {
    target.lenses = target.lenses.length
      ? target.lenses.filter(name => repo.lenses!.includes(name))
      : [...repo.lenses]
  }
  if (repo.architectureSources?.length) {
    target.architectureSources = [...new Set([...target.architectureSources, ...repo.architectureSources])]
  }
  // Deliberately ignored: mcpRoles, references, contractCheckers,
  // allowCodeExecution, eventSource, identity, scms. A pull request
  // must not be able to grant itself tools, docs, or execution.
}

function assign<K extends keyof ReviewPolicy>(target: ReviewPolicy, key: K, value: ReviewPolicy[K]): void {
  target[key] = value
}

export function severityAtLeast(severity: ReviewSeverity, floor: ReviewSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[floor]
}

/**
 * What actually gets posted, after autonomy and the approval rule.
 *
 * `event` is what the SCM submission carries. `holdVerdict` means the
 * decision (approve / request changes) is parked for a human even when
 * the comments themselves were posted.
 *
 * `developerApproved` is a human who read the draft, verdict included, and
 * approved it. That is the decision `approval: recommend` waits for, so the
 * verdict is posted rather than held for a second approval. `approval:
 * never` still never posts a decision.
 */
export function effectiveSubmission(
  policy: ReviewPolicy,
  verdict: 'approve' | 'request_changes' | 'comment',
  opts: { developerApproved?: boolean } = {},
): { event: 'approve' | 'request_changes' | 'comment' | 'pending'; holdVerdict: boolean } {
  if (policy.autonomy === 'draft') return { event: 'pending', holdVerdict: true }
  if (verdict === 'comment') return { event: 'comment', holdVerdict: false }
  if (opts.developerApproved && policy.approval !== 'never') return { event: verdict, holdVerdict: false }

  const mayPostDecision = policy.autonomy === 'full'
    && (verdict === 'request_changes' ? policy.approval !== 'never' : policy.approval === 'auto')
  if (mayPostDecision) return { event: verdict, holdVerdict: false }

  const hold = policy.approval !== 'never'
  return { event: 'comment', holdVerdict: hold }
}
