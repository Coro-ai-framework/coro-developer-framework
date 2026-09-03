// ─────────────────────────────────────────────────────────────────────────────
// Server-side plan-mode conversation state.
//
// Plan mode used to be stateless: the dashboard owned the transcript and
// re-sent it whole on every turn. That worked while a session was three
// clarifying questions long, but it drops tool results at the turn
// boundary — `ChatRequest.messages` carries only role/content strings, so
// everything the model read during turn N was invisible in turn N+1. An
// investigative intake would re-read the same files every turn and reason
// from summaries of its own summaries.
//
// So the runner keeps the conversation here, keyed by the dashboard's
// session id, and the client posts only the new user message. Tool results
// are folded back into the replayed assistant turns as `<evidence>` blocks
// (clamped per call) so the investigation compounds instead of resetting.
//
// This is deliberately in-memory: a plan-mode session is a single
// developer's live browser tab, not durable state. A runner restart loses
// it, and the dashboard still holds the visible transcript either way.
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
  updatedAt: number
}

const sessions = new Map<string, IntakeSession>()

function sweep(now: number): void {
  for (const [id, session] of sessions) {
    if (now - session.updatedAt > INTAKE_SESSION_TTL_MS) sessions.delete(id)
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
  return sessions.delete(sessionId)
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
  const session = getIntakeSession(sessionId)
  if (session.turns.length > 0) return session
  let pendingUser: string | null = null
  for (const message of messages) {
    if (message.role === 'user') {
      if (pendingUser !== null) {
        session.turns.push({ user: pendingUser, assistant: '(no reply recorded)', evidence: [] })
      }
      pendingUser = message.content
      continue
    }
    if (pendingUser === null) continue
    session.turns.push({ user: pendingUser, assistant: message.content, evidence: [] })
    pendingUser = null
  }
  return session
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
    assistant: turn.assistant || '(no reply recorded)',
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
  sessions.clear()
}
