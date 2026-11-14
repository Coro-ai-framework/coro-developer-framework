import fs from 'node:fs'
import path from 'node:path'
import type { Job } from '@coro-ai/cloud-protocol'
import { branchExists, gitResult, isAncestor } from './git'
import { STATUS } from './coro-client'

/**
 * The simulated human reviewer.
 *
 * Coro's pr-reviewer will not merge without a human approval, and with the
 * built-in `local` SCM plugin there is no server to click "approve" on: the
 * pull request is a JSON record under `<HOME>/.coro/local-scm/`. This is the
 * one place the harness reaches into a file Coro owns. If Coro changes that
 * record's shape, this file is the only one that needs updating.
 *
 * It does what a person using local mode does, in two steps:
 *
 *   1. When the job parks on a pull request, approve every open one.
 *   2. When the job marks a pull request merged, merge its branch into the
 *      sandbox's `main`. The local plugin deliberately does not touch the
 *      repository ("the human does the merge"), and without this a job with
 *      several work items would cut each branch from an `main` that has none
 *      of the earlier ones.
 */

/** The fields of the local plugin's PR record the reviewer reads or writes. */
export interface LocalPrRecord {
  id: string
  title?: string
  sourceBranch: string
  targetBranch?: string
  state: 'open' | 'merged' | 'declined' | 'superseded'
  approvalCount: number
  comments?: unknown[]
  [extra: string]: unknown
}

/** The local plugin names each repository's record file after its path. */
export function storeFileName(repoKey: string): string {
  return `${repoKey.replace(/[^\w.-]+/g, '_')}.json`
}

export function storeDir(home: string): string {
  return path.join(home, '.coro', 'local-scm')
}

export type ReviewerAction =
  | { kind: 'approved'; prId: string }
  | { kind: 'merged'; prId: string; branch: string }
  | { kind: 'merge-failed'; prId: string; branch: string; detail: string }

export function describeAction(action: ReviewerAction): string {
  switch (action.kind) {
    case 'approved':
      return `reviewer: approved PR ${action.prId}`
    case 'merged':
      return `reviewer: merged ${action.branch} (PR ${action.prId}) into main`
    case 'merge-failed':
      return `reviewer: could not merge ${action.branch} (PR ${action.prId}): ${action.detail}`
  }
}

export interface ReviewerOptions {
  /** The attempt's isolated HOME. */
  home: string
  /** The sandbox git repository the job was dispatched against. */
  sandbox: string
  /** How long a parked job waits before the reviewer approves. */
  approveAfterMs: number
  now?: () => number
}

type ReviewableJob = Pick<Job, 'status'>

export class SimulatedReviewer {
  private readonly now: () => number
  /** When the current park on a pull request was first seen. */
  private parkedSince: number | undefined
  /** Branches that failed to merge; retrying a conflict every poll would only repeat it. */
  private readonly failedMerges = new Set<string>()

  constructor(private readonly options: ReviewerOptions) {
    this.now = options.now ?? Date.now
  }

  /** One look at the job. Returns what the reviewer did, in order. */
  async tick(job: ReviewableJob): Promise<ReviewerAction[]> {
    const actions: ReviewerAction[] = []
    actions.push(...(await this.mergeMergedPrs()))

    if (job.status === STATUS.awaitingPrMerge) {
      this.parkedSince ??= this.now()
      if (this.now() - this.parkedSince >= this.options.approveAfterMs) {
        actions.push(...this.approveOpenPrs())
      }
    } else {
      this.parkedSince = undefined
    }
    return actions
  }

  // ── The record files ───────────────────────────────────────────────────────

  /** The sandbox's own record file, or every record file if Coro keyed it differently. */
  private recordFiles(): string[] {
    const dir = storeDir(this.options.home)
    const expected = path.join(dir, storeFileName(this.options.sandbox))
    if (fs.existsSync(expected)) return [expected]
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .map(name => path.join(dir, name))
  }

  private read(file: string): LocalPrRecord[] {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'))
      return Array.isArray(parsed) ? (parsed as LocalPrRecord[]) : []
    } catch {
      // Mid-write by the runner; the next tick will see it whole.
      return []
    }
  }

  /** Write via a temp file so the runner never reads half of it. */
  private write(file: string, records: LocalPrRecord[]): void {
    const tmp = `${file}.eval-${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2))
    fs.renameSync(tmp, file)
  }

  // ── Step 1: approve ────────────────────────────────────────────────────────

  private approveOpenPrs(): ReviewerAction[] {
    const actions: ReviewerAction[] = []
    for (const file of this.recordFiles()) {
      const records = this.read(file)
      let changed = false
      for (const record of records) {
        if (record.state === 'open' && (record.approvalCount ?? 0) < 1) {
          record.approvalCount = 1
          changed = true
          actions.push({ kind: 'approved', prId: String(record.id) })
        }
      }
      if (changed) this.write(file, records)
    }
    return actions
  }

  // ── Step 2: merge ──────────────────────────────────────────────────────────

  private async mergeMergedPrs(): Promise<ReviewerAction[]> {
    const actions: ReviewerAction[] = []
    for (const file of this.recordFiles()) {
      for (const record of this.read(file)) {
        if (record.state !== 'merged' || !record.sourceBranch) continue
        const key = `${file}#${record.id}`
        if (this.failedMerges.has(key)) continue

        const outcome = await this.mergeBranch(record.sourceBranch)
        if (outcome === 'already-merged') continue
        if (outcome === 'merged') {
          actions.push({ kind: 'merged', prId: String(record.id), branch: record.sourceBranch })
        } else {
          this.failedMerges.add(key)
          actions.push({ kind: 'merge-failed', prId: String(record.id), branch: record.sourceBranch, detail: outcome.detail })
        }
      }
    }
    return actions
  }

  private async mergeBranch(branch: string): Promise<'merged' | 'already-merged' | { detail: string }> {
    const { sandbox } = this.options
    if (!(await branchExists(sandbox, branch))) return { detail: 'branch does not exist in the sandbox' }
    if (await isAncestor(sandbox, branch, 'main')) return 'already-merged'

    const merge = await gitResult(['merge', '--no-ff', '--no-edit', branch], sandbox)
    if (merge.code === 0) return 'merged'

    // Leave the sandbox clean so later merges and grading are not poisoned.
    await gitResult(['merge', '--abort'], sandbox)
    return { detail: (merge.stderr.trim() || merge.stdout.trim()).split('\n')[0] ?? 'merge failed' }
  }
}

/** Convenience for tests and tools: read a record file as the reviewer would. */
export function readRecords(file: string): LocalPrRecord[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'))
  return Array.isArray(parsed) ? (parsed as LocalPrRecord[]) : []
}