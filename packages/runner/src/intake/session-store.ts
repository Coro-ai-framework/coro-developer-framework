import { createHash } from 'crypto'
import { mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ExecutorSessionState } from '@coro-ai/plugin-sdk'
import type { InvestigationToolAccess } from '@coro-ai/cloud-protocol'
import { defaultConfigDir } from '../config/local-config'

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
// GET /intake/sessions/:id, and a message for a conversation the cache no
// longer holds, hydrate this Map from that row. Eviction (idle TTL, runner
// restart) only drops the cache: the scratch directory under
// `~/.coro/plan/<id>` lives until the conversation is deleted.
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
  /** Stable cwd for Claude Code persist/resume. Removed when the conversation is deleted. */
  workRoot?: string
  /** Per-conversation tool permission overrides. */
  toolAccess?: InvestigationToolAccess
  updatedAt: number
}

const sessions = new Map<string, IntakeSession>()
/**
 * Sessions with a turn inside `runIntakeStream`. A refresh drops the
 * browser's stream, but the runner keeps working — a second message in
 * that window used to reconcile an evidence-free transcript and make the
 * model start the investigation over.
 */
const activeTurns = new Set<string>()

/**
 * Ids the developer explicitly discarded, with the time of the DELETE.
 *
 * A turn already in flight finishes after the row is gone, and
 * `recordIntakeTurn` recreates the cache entry it writes into — so without a
 * tombstone the discarded conversation reappears in Recents carrying that one
 * turn. Session ids are minted UUIDs and never reused, so remembering them is
 * safe; the entries are swept on the same TTL as the sessions themselves.
 */
const discarded = new Map<string, number>()

/** True once this conversation has been deleted. Nothing may persist it again. */
export function isIntakeSessionDiscarded(sessionId: string): boolean {
  sweep(Date.now())
  return discarded.has(sessionId)
}

function removeDir(dir: string | undefined): void {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Best-effort: a leftover scratch dir is not worth failing close/reset.
  }
}

function removeWorkRoot(session: IntakeSession): void {
  removeDir(session.workRoot)
  session.workRoot = undefined
}

/**
 * Evicts idle sessions from the hot cache only. The durable row keeps the
 * resume blob and the scratch directory stays on disk, so the next message
 * picks the conversation up where it left off.
 */
function sweep(now: number): void {
  for (const [id, session] of sessions) {
    if (now - session.updatedAt <= INTAKE_SESSION_TTL_MS) continue
    sessions.delete(id)
  }
  for (const [id, deletedAt] of discarded) {
    if (now - deletedAt > INTAKE_SESSION_TTL_MS) discarded.delete(id)
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
  // The conversation may have been swept from the cache; its directory is still on disk.
  removeDir(intakeWorkRootPath(sessionId))
  discarded.set(sessionId, Date.now())
  return sessions.delete(sessionId)
}

/** Existing session only — does not create an empty one. */
export function peekIntakeSession(sessionId: string): IntakeSession | undefined {
  sweep(Date.now())
  return sessions.get(sessionId)
}

/**
 * Restore LLM cache from a durable investigation. Keeps an existing
 * `workRoot` so a live session's directory is not swapped mid-conversation.
 */
export function hydrateIntakeSession(record: {
  id: string
  turns: IntakeTurn[]
  tokens: number
  contextTokens: number
  executorSession?: ExecutorSessionState
  executorId?: string
  toolAccess?: InvestigationToolAccess
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
  if (record.toolAccess && !existing?.toolAccess) session.toolAccess = record.toolAccess
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

/** Prefix of the per-process temp directories plan mode used before {@link intakeScratchRoot}. */
const LEGACY_WORK_ROOT_PREFIX = 'coro-plan-'

/** How long a legacy temp directory is kept for manual recovery before it is pruned. */
export const LEGACY_INTAKE_WORK_ROOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Parent of every conversation's scratch directory: `~/.coro/plan`. */
export function intakeScratchRoot(): string {
  return join(defaultConfigDir(), 'plan')
}

const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/**
 * One directory per conversation, derived from its id so it survives cache
 * eviction and runner restarts. Ids come from the request body, so anything
 * that is not a plain token is hashed rather than joined into the path.
 */
export function intakeWorkRootPath(sessionId: string): string {
  const segment = SAFE_SESSION_SEGMENT.test(sessionId)
    ? sessionId
    : `id-${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}`
  return join(intakeScratchRoot(), segment)
}

/** Stable cwd so Claude Code can persist/resume one session per conversation. */
export function ensureIntakeWorkRoot(sessionId: string): string {
  const session = getIntakeSession(sessionId)
  if (session.workRoot) return session.workRoot
  const root = intakeWorkRootPath(sessionId)
  mkdirSync(join(root, '_intelligence'), { recursive: true })
  session.workRoot = root
  session.updatedAt = Date.now()
  return root
}

function legacyIntakeWorkRoots(): string[] {
  try {
    return readdirSync(tmpdir())
      .filter(name => name.startsWith(LEGACY_WORK_ROOT_PREFIX))
      .map(name => join(tmpdir(), name))
  } catch {
    return []
  }
}

/**
 * Every place plan-mode scratch files can live: the scratch root, plus the
 * temp directories older runners created, which earlier messages still name.
 */
export function listIntakeWorkRoots(): string[] {
  return [intakeScratchRoot(), ...legacyIntakeWorkRoots()]
}

/**
 * Removes legacy temp scratch directories nothing has touched for
 * `maxAgeMs`. Nothing creates them any more, and each restart used to
 * orphan one per open conversation. Recent ones are kept so their files can
 * still be recovered by hand. Returns how many were removed.
 */
export async function pruneLegacyIntakeWorkRoots(
  maxAgeMs = LEGACY_INTAKE_WORK_ROOT_MAX_AGE_MS,
  now = Date.now(),
): Promise<number> {
  let removed = 0
  for (const dir of legacyIntakeWorkRoots()) {
    if (now - lastTouchedMs(dir) <= maxAgeMs) continue
    try {
      await rm(dir, { recursive: true, force: true })
      removed++
    } catch {
      // Best-effort; the next start tries again.
    }
  }
  return removed
}

/** Newest mtime of the directory and its immediate entries; nested writes do not touch the parent. */
function lastTouchedMs(dir: string): number {
  try {
    let newest = statSync(dir).mtimeMs
    for (const name of readdirSync(dir)) {
      try {
        newest = Math.max(newest, statSync(join(dir, name)).mtimeMs)
      } catch {
        // Entry vanished while scanning.
      }
    }
    return newest
  } catch {
    return Number.POSITIVE_INFINITY
  }
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

export function updateIntakeToolAccess(
  sessionId: string,
  fn: (access: InvestigationToolAccess) => void,
): InvestigationToolAccess {
  const session = getIntakeSession(sessionId)
  session.toolAccess ??= { capabilities: {}, mcp: {}, allow: [], deny: [] }
  fn(session.toolAccess)
  session.updatedAt = Date.now()
  return session.toolAccess
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
    usage: {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens?: number
      cacheCreationInputTokens?: number
    }
    /**
     * Context size the executor measured after its final model call
     * (`ChatResult.contextTokens`). Preferred over anything derived from
     * `usage`, which is summed across every tool round of the turn.
     */
    contextTokens?: number
    /** Tokens billed this turn outside the parent's context (plan-mode subagents). */
    extraBilledTokens?: number
  },
): IntakeSession {
  const session = getIntakeSession(sessionId)
  session.turns.push({
    user: turn.user,
    assistant: turn.assistant || NO_REPLY,
    evidence: turn.evidence,
  })
  session.tokens += turn.usage.inputTokens + turn.usage.outputTokens + (turn.extraBilledTokens ?? 0)
  session.contextTokens = turn.contextTokens ?? estimateContextTokens(turn.usage)
  session.updatedAt = Date.now()
  return session
}

/**
 * Fallback for executors that do not report `contextTokens`. Follows the
 * SDK's usage convention (cache buckets are disjoint from `inputTokens`) —
 * leaving them out is what pinned the meter near 0% on prompt-cached
 * sessions. Exact for a single model call; over-counts a multi-round turn.
 */
function estimateContextTokens(usage: {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
}): number {
  return usage.inputTokens
    + (usage.cacheReadInputTokens ?? 0)
    + (usage.cacheCreationInputTokens ?? 0)
    + usage.outputTokens
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

/** True while this session's intake turn is still inside `runIntakeStream`. */
export function intakeTurnActive(sessionId: string): boolean {
  return activeTurns.has(sessionId)
}

/**
 * Claims the session's single in-flight turn. Returns false when one is
 * already running so the caller can refuse without touching the transcript.
 */
export function tryBeginIntakeTurn(sessionId: string): boolean {
  if (activeTurns.has(sessionId)) return false
  activeTurns.add(sessionId)
  return true
}

export function endIntakeTurn(sessionId: string): void {
  activeTurns.delete(sessionId)
}

export function resetIntakeSessionsForTests(): void {
  for (const session of sessions.values()) removeWorkRoot(session)
  sessions.clear()
  discarded.clear()
  activeTurns.clear()
}
