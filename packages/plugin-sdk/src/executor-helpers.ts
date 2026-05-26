// ── Executor authoring helpers ──────────────────────────────────────────────
//
// Dependency-light utilities every phase-executor plugin reaches for at
// the tool-call boundary. These helpers MUST stay behaviourally
// identical to the runner's own enforcement (`packages/runner/src/jobs/
// runner.ts → buildPhaseHooks`) — drift is a security gap, not a
// stylistic preference.
//
// Why duplicate (rather than re-export from the runner): plugins ship
// independently of the runner, so embedding the canonical enforcement
// into the SDK lets each provider build its own tool loop without
// importing `@coro-ai/runner`. The conformance test pack at
// `packages/plugin-sdk/tests/executor-helpers.test.ts` pins these
// against the runner's behaviour.

import * as path from 'node:path'
import type {
  ConversationMessage,
  NormalizedTokenUsage,
  PhaseExecutorEvent,
} from './types'

// ── Permission decisions ────────────────────────────────────────────────────

/**
 * Stable, executor-agnostic decision shape returned by every guard.
 * Plugins translate this into their provider's native deny payload at
 * the tool-call boundary.
 */
export interface PermissionDecision {
  allow: boolean
  /** Present when `allow` is false; safe to surface to the model. */
  reason?: string
}

const ALLOW: PermissionDecision = { allow: true }

// ── Tool whitelist ──────────────────────────────────────────────────────────

/**
 * Reject tool calls outside the phase's whitelist. Mirrors the runner's
 * PreToolUse `allowedTools` gate. A `null` whitelist means "no
 * whitelist" — every tool the executor exposes is allowed.
 *
 * The reason string is shaped so the model can self-correct (it lists
 * the permitted tools verbatim). Keep it stable: agent prompts and
 * memory entries reference this phrasing.
 */
export function enforceAllowedTools(
  toolName: string,
  allowed: ReadonlyArray<string> | null,
  ctx?: { phase?: string },
): PermissionDecision {
  if (!allowed || allowed.length === 0) return ALLOW
  if (allowed.includes(toolName)) return ALLOW
  const phaseLabel = ctx?.phase ? `phase ${ctx.phase}` : 'this phase'
  return {
    allow: false,
    reason:
      `Blocked ${toolName}: ${phaseLabel} only allows ${allowed.join(', ')}. ` +
      `Update the workflow if this phase needs broader tool access.`,
  }
}

// ── Filesystem write guard ──────────────────────────────────────────────────

/**
 * Reject `Write`/`Edit` (or any equivalent file-mutation tool) targeting
 * a path outside the allow-listed write roots. Mirrors the runner's
 * PreToolUse `Write`/`Edit` containment check.
 *
 * The path is resolved against `cwd` so relative inputs are checked
 * after normalisation; this defends against `..` traversal.
 *
 * Pass the input's path through `pathInputKeys` if your provider's tool
 * schema names the path field something other than `file_path`/`path`.
 */
export function enforceWriteGuard(args: {
  toolName: string
  toolInput: Record<string, unknown>
  cwd: string
  writeRoots: ReadonlyArray<string>
  /** Tool names that mutate the filesystem; default matches Anthropic. */
  writeToolNames?: ReadonlyArray<string>
  /** Keys to probe in `toolInput` for the target path. */
  pathInputKeys?: ReadonlyArray<string>
}): PermissionDecision {
  const writeTools = args.writeToolNames ?? ['Write', 'Edit']
  if (!writeTools.includes(args.toolName)) return ALLOW
  if (args.writeRoots.length === 0) {
    return {
      allow: false,
      reason:
        `Blocked ${args.toolName}: no write roots configured for this phase. ` +
        `Use \`propose_change\` for intelligence-layer edits.`,
    }
  }
  const keys = args.pathInputKeys ?? ['file_path', 'path']
  let rawPath: unknown
  for (const k of keys) {
    if (args.toolInput[k] !== undefined) {
      rawPath = args.toolInput[k]
      break
    }
  }
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    // Cannot validate without a target path — defer to the upstream
    // tool schema; missing/empty path will fail at the tool itself.
    return ALLOW
  }
  const abs = path.resolve(args.cwd, rawPath)
  for (const root of args.writeRoots) {
    if (isPathInside(abs, root)) return ALLOW
  }
  return {
    allow: false,
    reason:
      `Blocked ${args.toolName}: "${rawPath}" resolves to ${abs}, which is outside ` +
      `the allowed write roots. Permitted: ${args.writeRoots.map((r) => `${r}/**`).join(', ')}. ` +
      `Use \`propose_change\` for changes to the intelligence repo.`,
  }
}

/**
 * Path containment check. Defends against `..` escapes by checking the
 * relative path does not start with `..` and is not absolute. Exposed
 * for plugins that build composite write-guard policies.
 */
export function isPathInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// ── Usage accumulation ──────────────────────────────────────────────────────

/**
 * Fold a `usage` event into a running accumulator. Use this when an
 * executor reports incremental usage between turns (rather than once
 * per phase). The accumulator is `NormalizedTokenUsage`-shaped so it
 * can be returned directly as the final phase usage.
 *
 * `totalCostUsd` is summed when present on either side; `undefined`
 * means "not reported" rather than "zero", so passing `undefined` does
 * not zero out a previously-recorded cost.
 */
export function accumulateNormalizedUsage(
  acc: NormalizedTokenUsage,
  next: NormalizedTokenUsage,
): NormalizedTokenUsage {
  const merged: NormalizedTokenUsage = {
    inputTokens: acc.inputTokens + next.inputTokens,
    outputTokens: acc.outputTokens + next.outputTokens,
    cacheReadInputTokens: acc.cacheReadInputTokens + next.cacheReadInputTokens,
    cacheCreationInputTokens:
      acc.cacheCreationInputTokens + next.cacheCreationInputTokens,
  }
  if (acc.totalCostUsd !== undefined || next.totalCostUsd !== undefined) {
    merged.totalCostUsd = (acc.totalCostUsd ?? 0) + (next.totalCostUsd ?? 0)
  }
  return merged
}

/**
 * Convenience constructor — start an accumulator at zero. Avoids
 * sprinkling magic literals across executor implementations.
 */
export function emptyNormalizedUsage(): NormalizedTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  }
}

// ── Conversation history merge ──────────────────────────────────────────────

/**
 * Append new messages to a prior conversation history while preserving
 * referential immutability of the input arrays. Useful for
 * stateless-resume executors that persist `conversationHistory` between
 * phases — they can compose `prev` (from `sessionState`) with the new
 * turns produced by the current phase before yielding `done`.
 *
 * No deduplication: callers are responsible for not double-appending
 * the same turn (the executor's tool loop owns its own ordering).
 */
export function mergeConversationHistory(
  prev: ReadonlyArray<ConversationMessage> | undefined,
  next: ReadonlyArray<ConversationMessage>,
): ReadonlyArray<ConversationMessage> {
  if (!prev || prev.length === 0) return next
  if (next.length === 0) return prev
  return [...prev, ...next]
}

// ── Tool-call logging ───────────────────────────────────────────────────────

/**
 * Render a tool-call into a single log line, redacting sensitive input
 * keys (api keys, tokens, …). The runner-side log shipper consumes
 * these verbatim, so changes to the format are observable.
 *
 * Output shape:
 *   `tool=<name> input={"k":"v",...}` (truncated at 1 KiB)
 *
 * Redaction policy: any key whose lower-cased name contains one of the
 * `redactedKeyFragments` substrings is replaced with `'[REDACTED]'`
 * before serialisation. Default fragments cover the common cases
 * (`token`, `secret`, `password`, `apikey`, `authorization`).
 */
export function formatToolCallLogLine(args: {
  toolName: string
  input: unknown
  redactedKeyFragments?: ReadonlyArray<string>
  /** Hard cap on the rendered JSON; defaults to 1 KiB. */
  maxInputBytes?: number
}): string {
  const fragments = (
    args.redactedKeyFragments ?? [
      'token',
      'secret',
      'password',
      'apikey',
      'api_key',
      'authorization',
    ]
  ).map((f) => f.toLowerCase())
  const max = args.maxInputBytes ?? 1024
  const redacted = redactDeep(args.input, fragments)
  let json: string
  try {
    json = JSON.stringify(redacted)
  } catch {
    json = '"[unserializable]"'
  }
  if (json.length > max) json = `${json.slice(0, max - 1)}…`
  return `tool=${args.toolName} input=${json}`
}

function redactDeep(
  value: unknown,
  fragments: ReadonlyArray<string>,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value as object)) return '[circular]'
  seen.add(value as object)
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, fragments, seen))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = k.toLowerCase()
    if (fragments.some((f) => lower.includes(f))) {
      out[k] = '[REDACTED]'
    } else {
      out[k] = redactDeep(v, fragments, seen)
    }
  }
  return out
}

// ── Event helpers ───────────────────────────────────────────────────────────

/**
 * Type guard for `usage` events — convenient when an executor's tool
 * loop forwards the same async iterator to multiple consumers and one
 * of them wants to fold usage into an accumulator.
 */
export function isUsageEvent(
  event: PhaseExecutorEvent,
): event is Extract<PhaseExecutorEvent, { type: 'usage' }> {
  return event.type === 'usage'
}

/** Type guard for the terminal `done` event. */
export function isDoneEvent(
  event: PhaseExecutorEvent,
): event is Extract<PhaseExecutorEvent, { type: 'done' }> {
  return event.type === 'done'
}
