// ── Per-phase observability ──────────────────────────────────────────────────
//
// Shared write/read helpers for the fields stamped onto `PhaseUsage` so
// the runner (write) and the retrospective history tools (read) cannot
// drift. Main-job execution only *records*; clustering and reports live
// in `tools/job-history.ts` / `tools/job-trace.ts` and are gated to
// retrospectives.

import type {
  PhaseRunAttribution,
  PhaseUsage,
  TokenUsage,
  ToolLedgerEntry,
} from '@coro-ai/cloud-protocol'

export const TOOL_LEDGER_MAX_ENTRIES = 64
export const TOOL_ERROR_CLASS_MAX_CHARS = 48

const ATTRIBUTION_VALUES: ReadonlySet<string> = new Set([
  'work-item',
  'checkpoint-resume',
  'rework',
])

const KNOWN_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /\bEPERM\b/i,
  /\bENOENT\b/i,
  /\bEACCES\b/i,
  /\bETIMEDOUT\b/i,
  /\bENOTFOUND\b/i,
  /\boperation not permitted\b/i,
  /\brate.?limit(?:ed)?\b/i,
  /\boverloaded\b/i,
  /\btimeout\b/i,
  /\b403\b/,
  /\b401\b/,
  /\b404\b/,
  /\b429\b/,
  /\b500\b/,
  /\b502\b/,
  /\b503\b/,
]

export function isPhaseRunAttribution(value: unknown): value is PhaseRunAttribution {
  return typeof value === 'string' && ATTRIBUTION_VALUES.has(value)
}

/** Checkpoint phase names from a persisted or parsed workflow phase list. */
export function checkpointPhaseSet(
  phases: ReadonlyArray<{ name: string; interactiveCheckpoint?: boolean }> | undefined,
): Set<string> {
  return new Set(
    (phases ?? []).filter(phase => phase.interactiveCheckpoint).map(phase => phase.name),
  )
}

export interface AttributionContext {
  checkpointPhases?: ReadonlySet<string>
  interactive?: boolean
}

/**
 * Attribute every phase execution. Prefers a value recorded at append
 * time; derives the rest with the same rules the runner uses when
 * stamping new snapshots, so mixed old/new jobs stay consistent.
 *
 * Derivation undercounts rework rather than inventing it: one resume
 * per (phase, work item) is allowed when the phase is a checkpoint and
 * the job was interactive. Independently of that allowance, a run whose
 * immediately preceding run of the same (phase, work item) carries a
 * `parkReason` (`pr:approved`, `developer-input: …`) is also a resume —
 * the gatekeeper merge (or equivalent) that follows a park is not a loop
 * the agent made on its own, even outside an interactive checkpoint.
 */
export function derivePhaseAttributions(
  phaseUsage: ReadonlyArray<Pick<PhaseUsage, 'phase' | 'workItem' | 'attribution' | 'parkReason'>>,
  context: AttributionContext = {},
): PhaseRunAttribution[] {
  const checkpointPhases = context.interactive ? context.checkpointPhases : undefined
  const seenWorkItems = new Map<string, Set<string>>()
  const resumeAllowanceUsed = new Map<string, Set<string>>()

  return phaseUsage.map((usage, index) => {
    const key = usage.workItem ?? ''
    const seen = seenWorkItems.get(usage.phase) ?? new Set<string>()
    const resumed = resumeAllowanceUsed.get(usage.phase) ?? new Set<string>()
    const previous = index > 0 ? phaseUsage[index - 1] : undefined
    const followsPark = previous?.phase === usage.phase
      && (previous?.workItem ?? '') === key
      && Boolean(previous?.parkReason)

    let attribution: PhaseRunAttribution
    if (isPhaseRunAttribution(usage.attribution)) {
      attribution = usage.attribution
      seen.add(key)
      if (attribution === 'checkpoint-resume') resumed.add(key)
    } else if (!seen.has(key)) {
      seen.add(key)
      attribution = 'work-item'
    } else if (followsPark) {
      attribution = 'checkpoint-resume'
    } else if (checkpointPhases?.has(usage.phase) && !resumed.has(key)) {
      resumed.add(key)
      attribution = 'checkpoint-resume'
    } else {
      attribution = 'rework'
    }

    seenWorkItems.set(usage.phase, seen)
    resumeAllowanceUsed.set(usage.phase, resumed)
    return attribution
  })
}

export function attributionForIncoming(
  prior: ReadonlyArray<Pick<PhaseUsage, 'phase' | 'workItem' | 'attribution' | 'parkReason'>>,
  incoming: Pick<PhaseUsage, 'phase' | 'workItem'>,
  context: AttributionContext,
): PhaseRunAttribution {
  const attributed = derivePhaseAttributions([...prior, incoming], context)
  return attributed[attributed.length - 1] ?? 'work-item'
}

export interface BuildPhaseSnapshotArgs {
  phase: string
  workItem?: string | null
  tokens: Pick<TokenUsage, 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'>
  costUsd: number
  durationMs: number
  durationApiMs: number
  numTurns: number
  model: string
  modelUsage?: PhaseUsage['modelUsage']
  priorUsage: ReadonlyArray<PhaseUsage>
  checkpointPhases: ReadonlySet<string>
  interactive: boolean
  parkReason?: string
  toolLedger?: ReadonlyArray<ToolLedgerEntry>
  sessionId?: string
}

export function buildPhaseSnapshot(args: BuildPhaseSnapshotArgs): PhaseUsage {
  const workItem = args.workItem?.trim() || undefined
  const incoming = { phase: args.phase, ...(workItem ? { workItem } : {}) }
  const attribution = attributionForIncoming(args.priorUsage, incoming, {
    checkpointPhases: args.checkpointPhases,
    interactive: args.interactive,
  })
  const ledger = capToolLedger(args.toolLedger)

  return {
    phase: args.phase,
    ...(workItem ? { workItem } : {}),
    inputTokens: args.tokens.inputTokens,
    outputTokens: args.tokens.outputTokens,
    cacheReadInputTokens: args.tokens.cacheReadInputTokens,
    cacheCreationInputTokens: args.tokens.cacheCreationInputTokens,
    costUsd: args.costUsd,
    durationMs: args.durationMs,
    durationApiMs: args.durationApiMs,
    numTurns: args.numTurns,
    model: args.model,
    ...(args.modelUsage ? { modelUsage: args.modelUsage } : {}),
    attribution,
    ...(args.parkReason ? { parkReason: args.parkReason } : {}),
    ...(ledger.length > 0 ? { toolLedger: ledger } : {}),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
  }
}

/**
 * Baseline cost already booked for the session a resumed run belongs to.
 * Claude Code's reported `total_cost_usd` is cumulative for the whole
 * session, not just this phase, so a resumed run must subtract only what
 * its *own session* already booked — including runs that themselves
 * booked $0 (a signal-terminated run whose cost was recovered by
 * `estimatePhaseCostUsd` or a genuine no-op). Summing by `sessionId`
 * rather than reading the job-level total keeps a $0 run from silently
 * moving its cost onto whichever run happens to end normally next.
 *
 * Falls back to the supplied job-level total when no prior snapshot
 * carries *this* `sessionId` (jobs persisted before this field existed,
 * or a session whose earlier runs predate a runner upgrade that adds
 * it) — the same coarser baseline the runner used previously. Once every
 * run in the session postdates the field, the sum is exact again.
 */
export function sessionCostBaseline(
  priorUsage: ReadonlyArray<Pick<PhaseUsage, 'costUsd' | 'sessionId'>>,
  sessionId: string | undefined,
  fallbackJobTotalCostUsd: number,
): number {
  if (!sessionId) return fallbackJobTotalCostUsd
  const sessionEntries = priorUsage.filter(entry => entry.sessionId === sessionId)
  if (sessionEntries.length === 0) return fallbackJobTotalCostUsd
  return sessionEntries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0)
}

/**
 * Coarse USD-per-million-token pricing, used only as a last resort when a
 * phase run is cut off by a signal (`await_event` / `goto_phase` /
 * `escalate`) before the executor's authoritative cost frame arrives.
 * A plausible estimated cost beats a false $0 that either gets lost or
 * silently lands on a later run. Unknown model families price at $0
 * rather than guess — this is a fallback, not a billing source of truth.
 */
const CLAUDE_PRICE_PER_MTOK: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  opus: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  haiku: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
}

function claudeModelFamily(model: string): keyof typeof CLAUDE_PRICE_PER_MTOK | undefined {
  const lower = model.toLowerCase()
  if (lower.includes('opus')) return 'opus'
  if (lower.includes('sonnet')) return 'sonnet'
  if (lower.includes('haiku')) return 'haiku'
  return undefined
}

export function estimatePhaseCostUsd(
  tokens: Pick<TokenUsage, 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'>,
  model: string,
): number {
  const family = claudeModelFamily(model)
  if (!family) return 0
  const price = CLAUDE_PRICE_PER_MTOK[family]
  const usd =
    (tokens.inputTokens / 1_000_000) * price.input
    + (tokens.outputTokens / 1_000_000) * price.output
    + (tokens.cacheReadInputTokens / 1_000_000) * price.cacheRead
    + (tokens.cacheCreationInputTokens / 1_000_000) * price.cacheWrite
  return Math.round(usd * 1e6) / 1e6
}

export function stampParkReason(
  usage: ReadonlyArray<PhaseUsage>,
  phase: string,
  parkReason: string,
): PhaseUsage[] {
  if (usage.length === 0) return usage as PhaseUsage[]
  const last = usage[usage.length - 1]
  if (!last || last.phase !== phase || last.parkReason) return usage as PhaseUsage[]
  return [...usage.slice(0, -1), { ...last, parkReason }]
}

export interface PendingToolCall {
  toolName: string
  startedAt: number
}

export function recordToolCall(
  pending: PendingToolCall[],
  toolName: string,
  startedAt: number,
): void {
  pending.push({ toolName, startedAt })
}

export function recordToolResult(
  pending: PendingToolCall[],
  ledger: ToolLedgerEntry[],
  args: { toolName: string; isError?: boolean; output: unknown; endedAt: number },
): void {
  let startedAt: number | undefined
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i]?.toolName === args.toolName) {
      startedAt = pending[i]?.startedAt
      pending.splice(i, 1)
      break
    }
  }
  const entry: ToolLedgerEntry = {
    toolName: args.toolName,
    success: args.isError !== true,
    durationMs: Math.max(0, args.endedAt - (startedAt ?? args.endedAt)),
  }
  if (args.isError === true) {
    entry.errorClass = classifyToolError(args.output)
  }
  ledger.push(entry)
  if (ledger.length > TOOL_LEDGER_MAX_ENTRIES) {
    ledger.splice(0, ledger.length - TOOL_LEDGER_MAX_ENTRIES)
  }
}

export function capToolLedger(
  entries: ReadonlyArray<ToolLedgerEntry> | undefined,
): ToolLedgerEntry[] {
  if (!entries || entries.length === 0) return []
  return entries.length <= TOOL_LEDGER_MAX_ENTRIES
    ? [...entries]
    : entries.slice(entries.length - TOOL_LEDGER_MAX_ENTRIES)
}

/**
 * Collapse a tool error payload into a short class. Paths, ids, and the
 * rest of the body are dropped so the ledger is safe to show an analyst
 * and cheap to cluster.
 */
export function classifyToolError(output: unknown): string {
  const text = stringifyToolOutput(output)
  for (const pattern of KNOWN_ERROR_PATTERNS) {
    const match = text.match(pattern)
    if (match?.[0]) {
      return clipErrorClass(match[0].toLowerCase().replace(/\s+/g, '-'))
    }
  }
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const stripped = firstLine.replace(/(?:[A-Za-z]:)?(?:\/|\\)[^\s]+/g, '').trim()
  return clipErrorClass(stripped.toLowerCase() || 'error')
}

export function normalizeErrorClass(text: string): string {
  return clipErrorClass(
    text
      .replace(/\b[0-9a-f]{8,}\b/gi, '')
      .replace(/\d+/g, 'N')
      .replace(/(?:[A-Za-z]:)?(?:\/|\\)[^\s]+/g, '<path>')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase(),
  )
}

function clipErrorClass(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= TOOL_ERROR_CLASS_MAX_CHARS) return trimmed || 'error'
  return `${trimmed.slice(0, TOOL_ERROR_CLASS_MAX_CHARS - 1)}…`
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output
  if (output == null) return ''
  if (typeof output === 'object' && output !== null && 'text' in output && typeof (output as { text: unknown }).text === 'string') {
    return (output as { text: string }).text
  }
  try {
    return JSON.stringify(output) ?? ''
  } catch {
    return String(output)
  }
}
