import fs from 'node:fs'
import path from 'node:path'
import type { Scenario } from './scenario'
import type { AttemptOutcome, JudgeScores } from './types'
import { PACKAGE_ROOT, slugify } from './util'

/**
 * Results as plain files. No database:
 *
 *   results/
 *     index.jsonl                  one line per attempt, appended as each finishes
 *     <runId>/
 *       run.json                   the resolved scenario, both commits, the task list
 *       summary.json               per-task and overall aggregates
 *       attempts/<task>-<n>/       job.json, timeline.json, job.log, runner.log,
 *                                  diff.patch, attempt.json, grade.json, judge.json
 *
 * `index.jsonl` is what history and compare read. An attempt is appended the
 * moment it is graded, so a run that is interrupted keeps what it finished.
 */

export const RESULTS_DIR = path.join(PACKAGE_ROOT, 'results')

/** One line of `index.jsonl`: everything a trend or a comparison needs, nothing it does not. */
export interface IndexRecord {
  runId: string
  label: string
  /** ISO timestamp the attempt was graded. */
  ts: string
  coroSha: string | null
  harnessSha: string | null
  scenarioHash: string
  lane: string
  taskId: string
  attempt: number
  solved: boolean
  outcome: AttemptOutcome
  expectedOutcomeMet: boolean
  costUsd: number
  wallMs: number
  agentMs: number
  reviewWaitMs: number
  phaseRuns: number
  reworkRuns: number
  inputTokens: number
  outputTokens: number
  /** Judge scores and their mean; absent when no judge ran. */
  judge?: JudgeScores & { mean: number }
}

/** `run.json`: what was run, precisely enough to reproduce it. */
export interface RunInfo {
  runId: string
  label: string
  startedAt: string
  finishedAt?: string
  scenario: Scenario
  scenarioHash: string
  /** The scenario file it was loaded from, if any. */
  scenarioFile?: string
  /** `--set` expressions and flags as given. */
  overrides: string[]
  /** Absolute path of the Coro checkout that was run. */
  coroPath: string
  /** Commit of that checkout, and whether it had uncommitted changes. */
  coroSha: string | null
  coroDirty: boolean
  /** Commit of the checkout this harness is running from. Differs from `coroSha` when `coroPath` is a worktree. */
  harnessSha: string | null
  harnessDirty: boolean
  tasks: string[]
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** `2026-11-14T13-40-00_label`, in local time like the date a person remembers the run by. */
export function formatRunId(date: Date, label: string): string {
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  const slug = slugify(label)
  return slug ? `${stamp}_${slug}` : stamp
}

export class ResultStore {
  constructor(readonly root: string = RESULTS_DIR) {}

  get indexPath(): string {
    return path.join(this.root, 'index.jsonl')
  }

  runDir(runId: string): string {
    return path.join(this.root, runId)
  }

  attemptDir(runId: string, taskId: string, attempt: number): string {
    return path.join(this.runDir(runId), 'attempts', `${taskId}-${attempt}`)
  }

  /** A run id that does not collide with an existing run directory. */
  newRunId(label: string, date: Date = new Date()): string {
    const base = formatRunId(date, label)
    let candidate = base
    for (let n = 2; fs.existsSync(this.runDir(candidate)); n++) candidate = `${base}-${n}`
    return candidate
  }

  // ── run.json / summary.json ────────────────────────────────────────────────

  writeRun(info: RunInfo): void {
    fs.mkdirSync(this.runDir(info.runId), { recursive: true })
    fs.writeFileSync(path.join(this.runDir(info.runId), 'run.json'), JSON.stringify(info, null, 2))
  }

  readRun(runId: string): RunInfo {
    return this.readJson<RunInfo>(path.join(this.runDir(runId), 'run.json'))
  }

  writeSummary(runId: string, summary: unknown): void {
    fs.writeFileSync(path.join(this.runDir(runId), 'summary.json'), JSON.stringify(summary, null, 2))
  }

  private readJson<T>(file: string): T {
    if (!fs.existsSync(file)) throw new Error(`Missing ${file}`)
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
  }

  // ── index.jsonl ────────────────────────────────────────────────────────────

  appendIndex(record: IndexRecord): void {
    fs.mkdirSync(this.root, { recursive: true })
    fs.appendFileSync(this.indexPath, `${JSON.stringify(record)}\n`)
  }

  /** Every attempt ever recorded, in file order. Lines that do not parse are skipped, not fatal. */
  readIndex(): IndexRecord[] {
    if (!fs.existsSync(this.indexPath)) return []
    const records: IndexRecord[] = []
    for (const line of fs.readFileSync(this.indexPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line) as IndexRecord)
      } catch {
        // a torn write from an interrupted run
      }
    }
    return records
  }

  readRunRecords(runId: string): IndexRecord[] {
    return this.readIndex().filter(record => record.runId === runId)
  }

  // ── Finding runs ───────────────────────────────────────────────────────────

  /** Run ids that have a `run.json`, oldest first. */
  listRunIds(): string[] {
    if (!fs.existsSync(this.root)) return []
    return fs
      .readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && fs.existsSync(path.join(this.root, entry.name, 'run.json')))
      .map(entry => entry.name)
      .sort()
  }

  /**
   * Resolve what a person typed: `latest`, an exact id, or any fragment of an
   * id (a label, a date) that matches exactly one run.
   */
  resolveRunId(reference: string): string {
    const ids = this.listRunIds()
    if (ids.length === 0) throw new Error(`No runs found in ${this.root}`)
    if (reference === 'latest') return ids[ids.length - 1]!
    if (ids.includes(reference)) return reference
    const matches = ids.filter(id => id.includes(reference))
    if (matches.length === 1) return matches[0]!
    if (matches.length === 0) throw new Error(`No run matches "${reference}". Known runs:\n  ${ids.slice(-10).join('\n  ')}`)
    throw new Error(`"${reference}" matches ${matches.length} runs; be more specific:\n  ${matches.join('\n  ')}`)
  }
}
