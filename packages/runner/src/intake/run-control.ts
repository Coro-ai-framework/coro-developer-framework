// ── Plan mode: acting on the runs a conversation started ────────────────────
//
// A conversation that dispatched a run stays the place the developer talks
// about it. These tools let the plan agent read a run's live log and, with
// the developer's approval for each call, steer, answer, pause, resume,
// cancel or switch it between interactive and autonomous.
//
// Two rules hold them in place:
//   - Ownership. Only runs whose `params.investigationId` is this
//     conversation can be acted on. Reading is open, as for past jobs.
//   - Approval. Every state-changing tool is classified under the `runs`
//     capability by `classifyIntakeTool`. Tools that resume or stop a run are
//     `mutating`, which the permission broker can only ever approve once.
//
// The tools are offered to the main plan agent only, never to subagents.

import type { ChatTool } from '@coro-ai/plugin-sdk'
import {
  PAUSED_AWAITING_EVENT,
  STATUS_CANCELLED,
  STATUS_COMPLETE,
  STATUS_ESCALATED,
  STATUS_FAILED,
  type Job,
} from '@coro-ai/cloud-protocol'
import type { StateBackend } from '../state/backend'

/** The slice of the dispatcher plan mode may drive. `Dispatcher` satisfies it. */
export interface RunControl {
  sendMessage(jobId: string, message: string): Promise<void>
  pauseJob(jobId: string, reason?: string): Promise<Job>
  resumeJob(jobId: string, fromPhase?: string, clearSession?: boolean): Promise<void>
  cancelJob(jobId: string, reason?: string): Promise<Job>
  setJobInteractive(jobId: string, value: boolean): Promise<Job>
}

export const READ_RUN_LOG_TOOL_NAME = 'read_run_log'
export const RUN_LOG_DEFAULT_TAIL = 80
export const RUN_LOG_MAX_TAIL = 400
export const RUN_LOG_MAX_CHARS = 24_000
const RUN_LOG_LINE_MAX_CHARS = 600
const SUBJECT_MAX_CHARS = 240

export const RUN_RELAY_PREFIX = "Relayed from the developer's plan-mode conversation, with their approval:\n\n"

interface RunControlSpec {
  title: string
  /** Resumes or stops a run. The broker asks for these on every call. */
  mutating: boolean
  description: string
  properties: Record<string, unknown>
  required: string[]
}

const JOB_ID = { type: 'string', description: 'Id of a run this conversation started.' }

const SPECS: Record<string, RunControlSpec> = {
  message_run: {
    title: 'Send guidance to a run',
    mutating: false,
    description:
      'Send guidance to a run this conversation started while it is working. The run reads it at its next step. ' +
      'Does not work on a run that is paused, parked or waiting for an answer — use answer_run for those.',
    properties: { jobId: JOB_ID, message: { type: 'string', description: 'The exact guidance to send.' } },
    required: ['jobId', 'message'],
  },
  answer_run: {
    title: 'Answer a waiting run and resume it',
    mutating: true,
    description:
      'Reply to a run this conversation started that is stopped: waiting for a question or checkpoint, parked, paused, ' +
      'escalated, or failed. The run resumes with your reply. Only send an answer the developer gave or agreed to.',
    properties: { jobId: JOB_ID, message: { type: 'string', description: 'The exact reply to send.' } },
    required: ['jobId', 'message'],
  },
  pause_run: {
    title: 'Pause a run',
    mutating: false,
    description: 'Pause a working run this conversation started at its next safe point.',
    properties: { jobId: JOB_ID, reason: { type: 'string', description: 'One line: why it is being paused.' } },
    required: ['jobId'],
  },
  resume_run: {
    title: 'Resume a run',
    mutating: true,
    description:
      'Re-run the current phase of a failed or escalated run this conversation started, without a message. ' +
      'Prefer answer_run when the run needs guidance to get unstuck.',
    properties: { jobId: JOB_ID },
    required: ['jobId'],
  },
  cancel_run: {
    title: 'Cancel a run',
    mutating: true,
    description: 'Cancel a run this conversation started. Only when the developer asked for it.',
    properties: { jobId: JOB_ID, reason: { type: 'string', description: 'One line: why it is cancelled.' } },
    required: ['jobId', 'reason'],
  },
  set_run_mode: {
    title: 'Change how a run asks for approval',
    // Going autonomous waives every checkpoint still ahead, so it is a
    // decision the developer makes call by call.
    mutating: true,
    description:
      'Switch a run this conversation started between interactive (pauses at each checkpoint for the developer) ' +
      'and autonomous (runs through). Not while the run is stopped — answer it with answer_run instead.',
    properties: { jobId: JOB_ID, interactive: { type: 'boolean', description: 'true for interactive, false for autonomous.' } },
    required: ['jobId', 'interactive'],
  },
}

export const RUN_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(SPECS))

function str(input: unknown, key: string): string {
  if (!input || typeof input !== 'object') return ''
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value.trim() : ''
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** What the permission card shows for a run-control call: which run, and the exact text going to it. */
export function describeRunControl(toolName: string, input: unknown): { title: string; subject: string; mutating: boolean } | null {
  const spec = SPECS[toolName]
  if (!spec) return null
  const jobId = str(input, 'jobId') || 'unknown run'
  const text = str(input, 'message') || str(input, 'reason')
  const mode = toolName === 'set_run_mode' && input && typeof input === 'object'
    ? ((input as Record<string, unknown>).interactive === true ? 'interactive' : 'autonomous')
    : ''
  const detail = text || mode
  return {
    title: spec.title,
    subject: clip(detail ? `${jobId}: ${detail}` : jobId, SUBJECT_MAX_CHARS),
    mutating: spec.mutating,
  }
}

export function buildRunControlTools(): ChatTool[] {
  return Object.entries(SPECS).map(([name, spec]) => ({
    name,
    description: spec.description,
    inputSchema: { type: 'object', properties: spec.properties, required: spec.required },
  }))
}

export function buildRunReadTools(): ChatTool[] {
  return [{
    name: READ_RUN_LOG_TOOL_NAME,
    description:
      'Read the newest lines of a run\'s live log: what its agent is doing right now, tool calls, errors, and ' +
      'developer messages. Read-only, any run. Use after get_past_job when status alone does not explain it.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Run id.' },
        tail: { type: 'number', description: `Lines from the end (default ${RUN_LOG_DEFAULT_TAIL}, cap ${RUN_LOG_MAX_TAIL}).` },
        contains: { type: 'string', description: 'Only lines containing this text (case-insensitive).' },
      },
      required: ['jobId'],
    },
  }]
}

const TERMINAL = new Set([STATUS_COMPLETE, STATUS_CANCELLED])

function isDeveloperPaused(job: Pick<Job, 'status' | 'awaitingEvent'>): boolean {
  return job.status === 'awaiting-developer-input' && job.awaitingEvent === PAUSED_AWAITING_EVENT
}

/** Stopped and waiting on someone: parked in any `awaiting-*` state, paused, escalated or failed. */
function isStopped(job: Pick<Job, 'status'>): boolean {
  return job.status.startsWith('awaiting-') || job.status === STATUS_ESCALATED || job.status === STATUS_FAILED
}

async function loadOwnedRun(
  toolName: string,
  jobId: string,
  sessionId: string,
  stateBackend: Pick<StateBackend, 'getJob'>,
): Promise<Job> {
  if (!jobId) throw new Error(`${toolName} requires a jobId.`)
  const job = await stateBackend.getJob(jobId)
  if (!job) throw new Error(`${toolName}: no run found with id "${jobId}".`)
  if (job.params?.['investigationId'] !== sessionId) {
    throw new Error(
      `${toolName}: run ${jobId} was not started by this conversation. You can read it with get_past_job and ` +
      'read_run_log, but not act on it.',
    )
  }
  return job
}

export interface RunControlDeps {
  runControl: RunControl
  stateBackend: Pick<StateBackend, 'getJob' | 'appendLog'>
  sessionId: string
}

export async function executeRunControl(
  toolName: string,
  args: Record<string, unknown>,
  deps: RunControlDeps,
): Promise<unknown> {
  const jobId = str(args, 'jobId')
  const job = await loadOwnedRun(toolName, jobId, deps.sessionId, deps.stateBackend)
  const { runControl } = deps
  let result: Record<string, unknown>

  switch (toolName) {
    case 'message_run': {
      const message = str(args, 'message')
      if (!message) throw new Error('message_run requires a message.')
      if (TERMINAL.has(job.status)) {
        throw new Error(`Run ${jobId} is ${job.status}. If more work is needed, propose a follow-up run with a <run> block.`)
      }
      if (isStopped(job)) {
        throw new Error(
          `Run ${jobId} is not working (${isDeveloperPaused(job) ? 'paused by the developer' : job.status}). ` +
          'Sending it a message would resume it — use answer_run, with the developer\'s agreement.',
        )
      }
      await runControl.sendMessage(jobId, `${RUN_RELAY_PREFIX}${message}`)
      result = { sent: true, status: job.status }
      break
    }
    case 'answer_run': {
      const message = str(args, 'message')
      if (!message) throw new Error('answer_run requires a message.')
      if (!isStopped(job)) {
        throw new Error(
          TERMINAL.has(job.status)
            ? `Run ${jobId} is ${job.status}. If more work is needed, propose a follow-up run with a <run> block.`
            : `Run ${jobId} is working, not waiting. Use message_run to steer it.`,
        )
      }
      await runControl.sendMessage(jobId, `${RUN_RELAY_PREFIX}${message}`)
      result = { sent: true, resumedFrom: job.status }
      break
    }
    case 'pause_run': {
      const updated = await runControl.pauseJob(jobId, str(args, 'reason') || undefined)
      result = { status: updated.status }
      break
    }
    case 'resume_run': {
      await runControl.resumeJob(jobId)
      result = { resumed: true, phase: job.phase }
      break
    }
    case 'cancel_run': {
      const reason = str(args, 'reason')
      if (!reason) throw new Error('cancel_run requires a reason.')
      const updated = await runControl.cancelJob(jobId, reason)
      result = { status: updated.status }
      break
    }
    case 'set_run_mode': {
      if (typeof args.interactive !== 'boolean') throw new Error('set_run_mode requires interactive: true or false.')
      // Going autonomous on a run parked at a checkpoint releases it into the
      // next phase. That is an approval, and approvals go through answer_run.
      if (isStopped(job)) {
        throw new Error(
          `Run ${jobId} is stopped (${job.status}). Changing its mode now could release it; ` +
          'answer it with answer_run, with the developer\'s agreement, and change the mode afterwards.',
        )
      }
      const updated = await runControl.setJobInteractive(jobId, args.interactive)
      result = { interactive: updated.interactive }
      break
    }
    default:
      throw new Error(`Unknown run-control tool: ${toolName}`)
  }

  await deps.stateBackend.appendLog(jobId, `[control] Plan conversation ${deps.sessionId}: ${toolName}`)
  return result
}

export interface ReadRunLogResult {
  jobId: string
  status: string
  phase: string
  lines: string[]
  totalLines: number
  truncated: boolean
}

export async function readRunLog(
  args: Record<string, unknown>,
  stateBackend: Pick<StateBackend, 'getJob' | 'getLog' | 'logLength'>,
): Promise<ReadRunLogResult> {
  const jobId = str(args, 'jobId')
  if (!jobId) throw new Error('read_run_log requires a jobId.')
  const job = await stateBackend.getJob(jobId)
  if (!job) throw new Error(`read_run_log: no run found with id "${jobId}".`)

  const requested = typeof args.tail === 'number' && Number.isFinite(args.tail) ? Math.floor(args.tail) : RUN_LOG_DEFAULT_TAIL
  const tail = Math.min(Math.max(requested, 1), RUN_LOG_MAX_TAIL)
  const contains = str(args, 'contains').toLowerCase()
  const total = await stateBackend.logLength(jobId)
  // A filter has to look further back than the tail it returns.
  const window = contains ? RUN_LOG_MAX_TAIL * 5 : tail
  const raw = await stateBackend.getLog(jobId, Math.max(0, total - window))

  let lines = raw
    .filter(line => !/^\S+Z\s+System prompt:/.test(line) && !line.startsWith('System prompt:'))
    .filter(line => !contains || line.toLowerCase().includes(contains))
    .slice(-tail)
    .map(line => clip(line, RUN_LOG_LINE_MAX_CHARS))

  let truncated = total > raw.length
  let size = lines.reduce((sum, line) => sum + line.length + 1, 0)
  while (size > RUN_LOG_MAX_CHARS && lines.length > 1) {
    size -= lines[0]!.length + 1
    lines = lines.slice(1)
    truncated = true
  }
  return { jobId, status: job.status, phase: job.phase, lines, totalLines: total, truncated }
}
