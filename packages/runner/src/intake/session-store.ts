import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ExecutorSessionState } from '@coro-ai/plugin-sdk'

// ─────────────────────────────────────────────────────────────────────────────
// Server-side plan-mode conversation state.
//
// One dashboard conversation is one session until the developer closes it
// (New conversation / dispatch reset / idle TTL / runner restart).
//
// Continuity is the same dual-shape the job runner uses:
//
//   - Claude Code (`supportsSessionResume`) — persist `sessionId` and a
//     stable work root so `chat()` resumes the same subprocess session
//     instead of flattening the transcript into a fresh one-shot prompt.
//   - Stateless executors (`supportsConversationReplay`) — persist
//     `conversationHistory` (native tool calls included) and replay it.
//
// `ChatRequest.messages` is the fallback: seed after a restart, a
// provider switch, or a stale Claude resume. Tool results are also
// folded into those messages as `<evidence>` so the fallback is not
// empty of what was read.
//
// This Map is the hot cache for the live LLM session (workRoot, resume
// blob). The durable copy lives on StateBackend (`investigations`).
// GET /intake/sessions/:id hydrates this Map from that row.
// ─────────────────────────────────────────────────────────────────────────────

/** Idle lifetime of a session before the sweeper drops it. */
export const INTAKE_SESSION_TTL_MS = 12 * 60 * 60 * 1000

/** Per-call ceiling on a replayed tool result. */
export const INTAKE_EVIDENCE_MAX_RESULT_CHARS = 6_000

/** Per-call ceiling on the rendered tool arguments. */
export const INTAKE_EVIDENCE_MAX_ARGS_CHARS = 240

/** One tool call, rendered once at record time and kept for replay. */
export interface IntakeEvidence {
  /** Tool name as invoked, e.g. `scm_read_file`. */
  name: string
  /** Compact rendering of the arguments. */
  args: string
  /** Clamped textual result (or the error text when the call failed). */
  result: string
  failed?: boolean
}

/** One completed exchange: what the developer said, what came back, what was read. */
export interface IntakeTurn {
  user: string
  assistant: string
  evidence: IntakeEvidence[]
}

export interface IntakeSession {
  id: string
  turns: IntakeTurn[]
  /** Cumulative billed tokens across the session. Display only — not a cap. */
  tokens: number
  /** Tokens resident in the model's context after the most recent turn. */
  contextTokens: number
  /**
   * Dual-shape resume blob from the last `chat()` result. Claude stores
   * `sessionId`; OpenAI stores `conversationHistory`. Cleared when the
   * developer switches provider so a Claude session is not resumed after
   * GPT turns the model never saw.
   */
  executorSession?: ExecutorSessionState
  /** Plugin id that wrote {@link executorSession}, e.g. `anthropic`. */
  executorId?: string
  /** Stable cwd for Claude Code persist/resume. Removed when the session dies. */
  workRoot?: string
  updatedAt: number
}

const sessions = new Map<string, IntakeSession>()

function removeWorkRoot(session: IntakeSession): void {
  if (!session.workRoot) return
  try {
    rmSync(session.workRoot, { recursive: true, force: true })
  } catch {
    // Best-effort: a leftover tmp dir is not worth failing close/reset.
  }
  session.workRoot = undefined
}

function sweep(now: number): void {
  for (const [id, session] of sessions) {
    if (now - session.updatedAt <= INTAKE_SESSION_TTL_MS) continue
    removeWorkRoot(session)
    sessions.delete(id)
  }
}

export function getIntakeSession(sessionId: string): IntakeSession {
  const now = Date.now()
  sweep(now)
  const existing = sessions.get(sessionId)
  if (existing) {
    existing.updatedAt = now
    return existing
  }
  const fresh: IntakeSession = {
    id: sessionId,
    turns: [],
    tokens: 0,
    contextTokens: 0,
    updatedAt: now,
  }
  sessions.set(sessionId, fresh)
  return fresh
}

export function deleteIntakeSession(sessionId: string): boolean {
  const existing = sessions.get(sessionId)
  if (existing) removeWorkRoot(existing)
  return sessions.delete(sessionId)
}

/** Existing session only — does not create an empty one. */
export function peekIntakeSession(sessionId: string): IntakeSession | undefined {
  sweep(Date.now())
  return sessions.get(sessionId)
}

/**
 * Restore LLM cache from a durable investigation. Keeps an existing
 * `workRoot` so a Claude resume that is still warm is not discarded.
 */
export function hydrateIntakeSession(record: {
  id: string
  turns: IntakeTurn[]
  tokens: number
  contextTokens: number
  executorSession?: ExecutorSessionState
  executorId?: string
}): IntakeSession {
  const now = Date.now()
  sweep(now)
  const existing = sessions.get(record.id)
  const session: IntakeSession = existing ?? {
    id: record.id,
    turns: [],
    tokens: 0,
    contextTokens: 0,
    updatedAt: now,
  }
  session.turns = record.turns.map(turn => ({
    user: turn.user,
    assistant: turn.assistant,
    evidence: Array.isArray(turn.evidence) ? turn.evidence : [],
  }))
  session.tokens = record.tokens
  session.contextTokens = record.contextTokens
  session.executorSession = record.executorSession
  session.executorId = record.executorId
  session.updatedAt = now
  sessions.set(record.id, session)
  return session
}

const NO_REPLY = '(no reply recorded)'

function turnsFromTranscript(
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): IntakeTurn[] {
  const turns: IntakeTurn[] = []
  let pendingUser: string | null = null
  for (const message of messages) {
    if (message.role === 'user') {
      if (pendingUser !== null) {
        turns.push({ user: pendingUser, assistant: NO_REPLY, evidence: [] })
      }
      pendingUser = message.content
      continue
    }
    if (pendingUser === null) continue
    turns.push({ user: pendingUser, assistant: message.content, evidence: [] })
    pendingUser = null
  }
  if (pendingUser !== null) {
    turns.push({ user: pendingUser, assistant: NO_REPLY, evidence: [] })
  }
  return turns
}

/**
 * Rebuilds or extends a session from the browser transcript.
 *
 * Empty server session → seed (runner restart, first request after the
 * dashboard restored a draft). Established session → append any extra
 * pairs the client has that the server never recorded (rate-limit,
 * empty output, abort). Evidence is gone for those recovered turns.
 */
export function reconcileIntakeSession(
  sessionId: string,
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): IntakeSession {
  const session = getIntakeSession(sessionId)
  const pairs = turnsFromTranscript(messages)
  if (session.turns.length === 0) {
    session.turns = pairs
    session.updatedAt = Date.now()
    return session
  }
  const appended = session.turns.length > 0 && pairs.length > session.turns.length
  for (let i = session.turns.length; i < pairs.length; i++) {
    session.turns.push(pairs[i]!)
  }
  if (appended) {
    // Recovered turns exist only as text. A Claude sessionId from before
    // the gap would resume without them.
    session.executorSession = undefined
  }
  session.updatedAt = Date.now()
  return session
}

/**
 * Seeds a session from a client-supplied transcript. Only used when a
 * browser that still holds a pre-server-state draft posts its history —
 * the evidence is gone in that case, but the prose survives.
 */
export function seedIntakeSession(
  sessionId: string,
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>,
): IntakeSession {
  return reconcileIntakeSession(sessionId, messages)
}

/** Stable cwd so Claude Code can persist/resume one session per conversation. */
export function ensureIntakeWorkRoot(sessionId: string): string {
  const session = getIntakeSession(sessionId)
  if (session.workRoot) return session.workRoot
  const root = mkdtempSync(join(tmpdir(), 'coro-plan-'))
  mkdirSync(join(root, '_intelligence'), { recursive: true })
  session.workRoot = root
  session.updatedAt = Date.now()
  return root
}

/**
 * Bind this conversation to an executor plugin. Switching provider
 * drops the prior resume blob so we never resume a Claude session
 * after GPT turns, or replay GPT history into Claude Code.
 */
export function bindIntakeExecutor(sessionId: string, executorId: string | undefined): void {
  if (!executorId) return
  const session = getIntakeSession(sessionId)
  if (session.executorId && session.executorId !== executorId) {
    session.executorSession = undefined
  }
  session.executorId = executorId
  session.updatedAt = Date.now()
}

export function persistIntakeExecutorSession(
  sessionId: string,
  executorSession: ExecutorSessionState | undefined,
): void {
  if (!executorSession) return
  const session = getIntakeSession(sessionId)
  session.executorSession = executorSession
  session.updatedAt = Date.now()
}

export function recordIntakeTurn(
  sessionId: string,
  turn: {
    user: string
    assistant: string
    evidence: IntakeEvidence[]
    usage: { inputTokens: number; outputTokens: number }
  },
): IntakeSession {
  const session = getIntakeSession(sessionId)
  session.turns.push({
    user: turn.user,
    assistant: turn.assistant || NO_REPLY,
    evidence: turn.evidence,
  })
  session.tokens += turn.usage.inputTokens + turn.usage.outputTokens
  session.contextTokens = turn.usage.inputTokens + turn.usage.outputTokens
  session.updatedAt = Date.now()
  return session
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`
}

function stringify(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Renders one executed tool call into the form kept for replay. Called at
 * record time so the raw payload (a 64 KB file read, a 200-entry
 * directory listing) is never retained beyond what the model will see
 * again.
 */
export function renderIntakeEvidence(call: {
  name: string
  input: unknown
  output: unknown
  error?: string
}): IntakeEvidence {
  const args = clamp(stringify(call.input), INTAKE_EVIDENCE_MAX_ARGS_CHARS)
  if (call.error) {
    return { name: call.name, args, result: `failed: ${call.error}`, failed: true }
  }
  return {
    name: call.name,
    args,
    result: clamp(stringify(call.output), INTAKE_EVIDENCE_MAX_RESULT_CHARS),
  }
}

function renderEvidenceBlock(evidence: IntakeEvidence[]): string {
  if (evidence.length === 0) return ''
  const lines = evidence.map(e => `- ${e.name}(${e.args}) →\n${e.result}`)
  return `\n\n<evidence>\n${lines.join('\n')}\n</evidence>`
}

/**
 * Rebuilds the `ChatRequest.messages` array for the next turn: strictly
 * alternating user/assistant starting with user, with each assistant turn
 * carrying the tool results it produced.
 */
export function buildIntakeMessages(
  session: IntakeSession,
  pendingUserMessage: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const turn of session.turns) {
    messages.push({ role: 'user', content: turn.user })
    messages.push({ role: 'assistant', content: turn.assistant + renderEvidenceBlock(turn.evidence) })
  }
  messages.push({ role: 'user', content: pendingUserMessage })
  return messages
}

export function resetIntakeSessionsForTests(): void {
  for (const session of sessions.values()) removeWorkRoot(session)
  sessions.clear()
}
