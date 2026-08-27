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
 * the job was interactive.
 */
export function derivePhaseAttributions(
  phaseUsage: ReadonlyArray<Pick<PhaseUsage, 'phase' | 'workItem' | 'attribution'>>,
  context: AttributionContext = {},
): PhaseRunAttribution[] {
  const checkpointPhases = context.interactive ? context.checkpointPhases : undefined
  const seenWorkItems = new Map<string, Set<string>>()
  const resumeAllowanceUsed = new Map<string, Set<string>>()

  return phaseUsage.map(usage => {
    const key = usage.workItem ?? ''
    const seen = seenWorkItems.get(usage.phase) ?? new Set<string>()
    const resumed = resumeAllowanceUsed.get(usage.phase) ?? new Set<string>()

    let attribution: PhaseRunAttribution
    if (isPhaseRunAttribution(usage.attribution)) {
      attribution = usage.attribution
      seen.add(key)
      if (attribution === 'checkpoint-resume') resumed.add(key)
    } else if (!seen.has(key)) {
      seen.add(key)
      attribution = 'work-item'
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
  prior: ReadonlyArray<Pick<PhaseUsage, 'phase' | 'workItem' | 'attribution'>>,
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
  }
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
