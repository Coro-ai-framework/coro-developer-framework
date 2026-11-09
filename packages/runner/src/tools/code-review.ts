// ── Code review lenses (coding jobs) ─────────────────────────────────────────
//
// The `code-reviewer` subagent of a coding job calls `code_review_lenses` to
// run the same lenses a pull-request review uses, on the working-tree diff,
// before any pull request exists. Findings go back to the coder and are kept
// in one `code-review` artefact; nothing is posted to the SCM.
//
// The lens runner, routing, and fingerprints are shared with
// `tools/pr-review.ts`. What differs is where the diff comes from (git, not
// an SCM API), where the lenses run (the checkout, with its project context
// loaded), and who pays: the spend is booked on the coding phase.

import { mkdir, stat, writeFile } from 'fs/promises'
import path from 'path'
import { isPrReviewJob, deriveRepoCheckoutDir } from '../jobs/helpers'
import { findingFingerprint } from '../reviews/id'
import { runLenses, runOneLens, type LensRun } from '../reviews/lens-runner'
import { readLocalDiff } from '../reviews/local-diff'
import { buildPacket, type ReviewPacket } from '../reviews/packet'
import { REVIEW_POLICY_DEFAULTS, severityAtLeast, type ReviewPolicy, type ReviewSeverity } from '../reviews/policy'
import type { ScmPrDiff } from '../plugins/types'
import type { LensConfig } from '../workflow-parser'
import type { ToolContext } from './types'

export const CODE_REVIEW_KIND = 'code-review'

/** Stand-in key for a job that has no work items. */
const WHOLE_JOB = 'job'

export interface CodeReviewFinding {
  /** `findingFingerprint(path, title, category)`; stable across passes. */
  fingerprint: string
  lens: string
  severity: ReviewSeverity
  category: string
  path?: string
  line?: number
  title: string
  body?: string
  sources?: { kind: string; ref: string }[]
  /** Set on a pass's results when the previous pass reported the same fingerprint. */
  seenBefore?: boolean
  /** Set by a verifier call that kept the finding. */
  verified?: boolean
  /** Set by a verifier call that dropped the finding. */
  dropped?: boolean
}

export interface CodeReviewItem {
  workItem: string
  base: string
  passes: number
  updatedAt: string
  files: number
  /** Lenses the last pass ran, with what each cost and found. */
  lenses: { name: string; findings: number; costUsd: number; inputTokens: number; outputTokens: number }[]
  findings: CodeReviewFinding[]
  notes: string[]
}

export interface CodeReviewData {
  items: CodeReviewItem[]
}

export type CodeReviewArgs = {
  /** Branch the pull request will target, e.g. `main`. */
  base: string
  /** Lens names to run. Omit to run every lens routed by the changed files. */
  lenses?: string[]
  /** Findings for the verifier to keep or drop. */
  candidates?: unknown[]
  /** Work item the findings belong to. Defaults to the job's current one. */
  workItem?: string
}

export type CodeReviewResult =
  | { status: 'unavailable'; reason: string }
  | {
      status: 'ok'
      mode: 'review' | 'verify'
      workItem: string
      pass: number
      files: number
      lensesRun: string[]
      findings: CodeReviewFinding[]
      /** Findings the previous pass of this work item reported, to compare against. */
      previous: CodeReviewFinding[]
      notes: string[]
    }

function assertCodeReviewJob(ctx: ToolContext): NonNullable<ToolContext['currentPhase']> {
  if (isPrReviewJob(ctx.job)) throw new Error('code_review_lenses is not available on a pr-review job; use review_run_lenses')
  const phase = ctx.currentPhase
  if (!phase) throw new Error('code_review_lenses: no active phase')
  if (!phase.phaseConf.lenses?.length) throw new Error('code_review_lenses: this phase declares no review lenses')
  return phase
}

/** Defaults come from the pull-request review policy so one setting tunes both. */
function policyFor(ctx: ToolContext): ReviewPolicy {
  const base = ctx.settings.reviews ?? REVIEW_POLICY_DEFAULTS
  const own = ctx.settings.codeReview
  return {
    ...base,
    ...(own?.minSeverity ? { minSeverity: own.minSeverity } : {}),
    ...(own?.maxParallelLenses ? { maxParallelLenses: own.maxParallelLenses } : {}),
  }
}

function renderDiff(diff: ScmPrDiff): string {
  return diff.files
    .map(file => [
      `=== ${file.path} (${file.status ?? 'modified'}, +${file.additions} -${file.deletions})`,
      file.patch ?? '(no textual patch: binary, too large, or unchanged content)',
    ].join('\n'))
    .join('\n\n')
}

/** Lenses named by the caller, or the ones the packet routes (the verifier never routes). */
function selectLenses(
  declared: LensConfig[],
  packet: ReviewPacket,
  requested: string[] | undefined,
): { lenses: { lens: LensConfig; paths: string[] }[]; note?: string } {
  const allPaths = packet.files.map(file => file.path)
  if (requested?.length) {
    const unknown = requested.filter(name => !declared.some(lens => lens.name === name))
    if (unknown.length > 0) throw new Error(`code_review_lenses: undeclared lenses: ${unknown.join(', ')}`)
    return {
      lenses: declared
        .filter(lens => requested.includes(lens.name))
        .map(lens => ({ lens, paths: packet.routes.find(route => route.name === lens.name)?.paths ?? allPaths })),
    }
  }
  if (packet.summaryOnly) {
    return {
      lenses: [],
      note: `The change is ${packet.totalLines} lines, over the review limit. Call again with \`lenses\` to review it anyway.`,
    }
  }
  const routed = packet.routes
    .map(route => ({ lens: declared.find(lens => lens.name === route.name), paths: route.paths }))
    .filter((item): item is { lens: LensConfig; paths: string[] } => item.lens !== undefined)
  if (routed.length === 0) return { lenses: [], note: 'No changed file is in scope for any declared lens.' }
  return { lenses: routed }
}

function taskFor(args: {
  checkout: string
  diffPath: string
  paths: string[]
  minSeverity: ReviewSeverity
  workItem: string
  candidates?: unknown[]
}): string {
  return [
    `You are reviewing a change that is still being written. Its checkout is your working directory: ${args.checkout}. The unified diff against the base branch is at ${args.diffPath}. Read files from the checkout; do not run anything from it.`,
    args.workItem !== WHOLE_JOB ? `Work item under review: ${args.workItem}.` : '',
    'Review only the files in your slice. Cite path and line from the working-tree version.',
    `Severity floor: ${args.minSeverity}. Do not emit findings below it.`,
    args.paths.length ? `Paths: ${args.paths.join(', ')}` : '',
    args.candidates ? `Candidates to verify:\n${JSON.stringify(args.candidates)}` : '',
    'Reply with a fenced JSON object: {"findings":[{"severity","category","path","line","title","body","sources":[{"kind","ref"}]}],"notes","sourcesUsed":["kind:ref"]}.',
  ].filter(Boolean).join('\n')
}

function toFinding(lens: string, raw: LensRun['result']['findings'][number]): CodeReviewFinding {
  return {
    fingerprint: findingFingerprint(raw.path, raw.title, raw.category),
    lens,
    severity: raw.severity,
    category: raw.category,
    ...(raw.path ? { path: raw.path } : {}),
    ...(raw.line !== undefined ? { line: raw.line } : {}),
    title: raw.title,
    ...(raw.body ? { body: raw.body } : {}),
    ...(raw.sources?.length ? { sources: raw.sources } : {}),
  }
}

/** One finding per fingerprint; the more severe copy wins. */
function dedupe(findings: CodeReviewFinding[]): CodeReviewFinding[] {
  const byFingerprint = new Map<string, CodeReviewFinding>()
  for (const finding of findings) {
    const seen = byFingerprint.get(finding.fingerprint)
    if (!seen || (!severityAtLeast(seen.severity, finding.severity) && severityAtLeast(finding.severity, seen.severity))) {
      byFingerprint.set(finding.fingerprint, finding)
    }
  }
  return [...byFingerprint.values()]
}

async function updateItem(
  ctx: ToolContext,
  workItem: string,
  change: (previous: CodeReviewItem | undefined) => CodeReviewItem,
): Promise<void> {
  const job = await ctx.stateBackend.getJob(ctx.job.id)
  if (!job) throw new Error('job not found')
  const artifacts = [...(job.artifacts ?? [])]
  const index = artifacts.findIndex(item => item.kind === CODE_REVIEW_KIND)
  const existing = index >= 0 ? artifacts[index] : undefined
  const data: CodeReviewData = existing ? structuredClone(existing.data as unknown as CodeReviewData) : { items: [] }
  const at = data.items.findIndex(item => item.workItem === workItem)
  const next = change(at >= 0 ? data.items[at] : undefined)
  if (at >= 0) data.items[at] = next
  else data.items.push(next)

  const now = new Date()
  const open = data.items.reduce((sum, item) => sum + item.findings.filter(finding => !finding.dropped).length, 0)
  const artifact = {
    id: existing?.id ?? `art-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    phase: existing?.phase ?? job.phase,
    kind: CODE_REVIEW_KIND,
    title: `Code review: ${open} finding${open === 1 ? '' : 's'}`,
    data: data as unknown as Record<string, unknown>,
    createdBy: existing?.createdBy ?? job.phase,
    createdAt: existing?.createdAt ?? now.toISOString(),
    ...(existing ? { editedAt: now.toISOString(), editedBy: job.phase } : {}),
  }
  if (index >= 0) artifacts[index] = artifact
  else artifacts.push(artifact)
  await ctx.stateBackend.updateJob(ctx.job.id, { artifacts })
  const refreshed = await ctx.stateBackend.getJob(ctx.job.id)
  if (refreshed) ctx.job = refreshed
}

async function previousItem(ctx: ToolContext, workItem: string): Promise<CodeReviewItem | undefined> {
  const job = await ctx.stateBackend.getJob(ctx.job.id)
  const artifact = job?.artifacts?.find(item => item.kind === CODE_REVIEW_KIND)
  const data = artifact?.data as unknown as CodeReviewData | undefined
  return data?.items?.find(item => item.workItem === workItem)
}

export async function codeReviewLenses(ctx: ToolContext, args: CodeReviewArgs): Promise<CodeReviewResult> {
  const phase = assertCodeReviewJob(ctx)
  if (ctx.settings.codeReview?.lenses === false) {
    return { status: 'unavailable', reason: 'Review lenses are turned off (codeReview.lenses is false).' }
  }
  if (typeof phase.executor.runSubagent !== 'function') {
    return { status: 'unavailable', reason: 'This phase\'s executor cannot run subagents.' }
  }

  const checkout = deriveRepoCheckoutDir(ctx.job, ctx.settings.paths.workingDir)
  if (!checkout || !(await stat(checkout).then(info => info.isDirectory(), () => false))) {
    throw new Error('code_review_lenses: the target repository is not checked out yet')
  }
  const policy = policyFor(ctx)
  const workItem = args.workItem?.trim() || ctx.job.currentWorkItem?.trim() || WHOLE_JOB
  const declared = phase.phaseConf.lenses ?? []
  const verifyOnly = args.lenses?.length === 1 && args.lenses[0] === 'verifier'

  const diff = await readLocalDiff(checkout, args.base)
  const diffDir = path.join(phase.workingDir, 'code-review')
  await mkdir(diffDir, { recursive: true })
  const diffPath = path.join(diffDir, 'diff.patch')
  await writeFile(diffPath, renderDiff(diff), 'utf8')

  const packet = buildPacket({
    files: diff.files.map(file => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
      ...(file.patch ? { hunks: file.patch } : {}),
    })),
    lenses: declared,
    maxDiffLines: policy.maxDiffLines,
    maxLensInputTokens: policy.maxLensInputTokens,
    contextTokens: 200_000,
  })

  const { lenses: selected, note } = selectLenses(declared, packet, args.lenses)
  const previous = await previousItem(ctx, workItem)
  const notes = note ? [note] : []

  const { runs, failed, spend } = await runLenses(
    selected,
    policy.maxParallelLenses,
    ({ lens }) => lens.name,
    ({ lens, paths }) => runOneLens(
      ctx,
      lens,
      taskFor({
        checkout,
        diffPath,
        paths,
        minSeverity: policy.minSeverity,
        workItem,
        ...(args.candidates ? { candidates: args.candidates } : {}),
      }),
      policy,
      { cwd: checkout, projectContext: 'load' },
    ),
    phase.signal,
  )
  phase.recordUsage?.(spend)
  // A failed verifier has no verdicts; applying none would drop every finding.
  if (verifyOnly && failed.length > 0) {
    throw new Error(`code_review_lenses: ${failed.map(lens => lens.error).join('; ')}`)
  }
  for (const run of runs) if (run.result.notes) notes.push(`${run.name}: ${run.result.notes}`)
  for (const lens of failed) notes.push(`${lens.name} lens failed: ${lens.error}`)

  const found = dedupe(
    runs.flatMap(run => run.result.findings
      .filter(finding => severityAtLeast(finding.severity, policy.minSeverity))
      .map(finding => toFinding(run.name, finding))),
  )
  const lensSummaries = runs.map(run => ({
    name: run.name,
    findings: run.result.findings.length,
    costUsd: run.usage.costUsd,
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
  }))
  const now = new Date().toISOString()

  if (verifyOnly) {
    // The verifier keeps or drops what an earlier pass found; it adds nothing.
    // A verifier may reword a title, so a finding also matches on its location.
    const keptFor = (finding: CodeReviewFinding): CodeReviewFinding | undefined =>
      found.find(item => item.fingerprint === finding.fingerprint)
      ?? found.find(item => item.path !== undefined && item.path === finding.path && item.line === finding.line && item.category === finding.category)
    await updateItem(ctx, workItem, prior => {
      const base: CodeReviewItem = prior ?? {
        workItem, base: args.base, passes: 0, updatedAt: now, files: diff.files.length, lenses: [], findings: [], notes: [],
      }
      return {
        ...base,
        updatedAt: now,
        lenses: [...base.lenses.filter(item => item.name !== 'verifier'), ...lensSummaries],
        findings: base.findings.map(finding => {
          const verdict = keptFor(finding)
          return verdict
            ? { ...finding, severity: verdict.severity, verified: true }
            : { ...finding, dropped: true }
        }),
      }
    })
    return {
      status: 'ok',
      mode: 'verify',
      workItem,
      pass: previous?.passes ?? 0,
      files: diff.files.length,
      lensesRun: runs.map(run => run.name),
      findings: found.map(finding => ({ ...finding, verified: true })),
      previous: previous?.findings ?? [],
      notes,
    }
  }

  const earlier = previous?.findings.filter(finding => !finding.dropped) ?? []
  const earlierPrints = new Set(earlier.map(finding => finding.fingerprint))
  const reported = found.map(finding => (earlierPrints.has(finding.fingerprint) ? { ...finding, seenBefore: true } : finding))
  await updateItem(ctx, workItem, prior => ({
    workItem,
    base: args.base,
    passes: (prior?.passes ?? 0) + 1,
    updatedAt: now,
    files: diff.files.length,
    lenses: lensSummaries,
    findings: found,
    notes,
  }))
  return {
    status: 'ok',
    mode: 'review',
    workItem,
    pass: (previous?.passes ?? 0) + 1,
    files: diff.files.length,
    lensesRun: runs.map(run => run.name),
    findings: reported,
    previous: earlier,
    notes,
  }
}
