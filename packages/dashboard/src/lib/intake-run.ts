export interface RunDraft {
  repo: string
  serviceName: string
  description: string
  /** Comma-separated reviewer names as typed on the Run card. Parsed at dispatch time. */
  reviewers: string
  workflowPath: string
  interactive: boolean
  /** The ticket this run belongs to. `pluginId` is a tracker plugin id or `mcp:<server>`. */
  trackerRef?: RunTrackerRef
  /** Per-run ticketing policy patch, sent as `params.ticketing`. */
  ticketing?: Record<string, unknown>
}

export interface RunTrackerRef {
  pluginId?: string
  externalId: string
  url?: string
}

export type RunTicketUpdates = 'default' | 'off' | 'status-sync' | 'subtasks' | 'custom'

/** Split a comma-separated reviewers field into trimmed, non-empty names. */
export function parseReviewersList(text: string): string[] {
  return text.split(',').map(s => s.trim()).filter(Boolean)
}

function parseTrackerRef(value: unknown): RunTrackerRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const ref = value as Record<string, unknown>
  const externalId = typeof ref.externalId === 'string' ? ref.externalId.trim()
    : typeof ref.key === 'string' ? ref.key.trim() : ''
  if (!externalId) return undefined
  const pluginId = typeof ref.pluginId === 'string' ? ref.pluginId.trim() : ''
  const url = typeof ref.url === 'string' ? ref.url.trim() : ''
  return { externalId, ...(pluginId ? { pluginId } : {}), ...(url ? { url } : {}) }
}

function parseTicketing(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.keys(value).length > 0 ? (value as Record<string, unknown>) : undefined
}

/** How the run card summarises `ticketing`. Anything beyond one preset or `enabled: false` is `custom`. */
export function ticketUpdatesOf(ticketing: Record<string, unknown> | undefined): RunTicketUpdates {
  if (!ticketing) return 'default'
  const { createSourceTicket: _create, ...rest } = ticketing
  const keys = Object.keys(rest)
  if (keys.length === 0) return 'default'
  if (keys.length === 1 && rest.enabled === false) return 'off'
  if (keys.length === 1 && (rest.preset === 'status-sync' || rest.preset === 'subtasks')) return rest.preset
  return 'custom'
}

/** Applies a run-card choice, keeping a `createSourceTicket` request the choice does not cancel. */
export function withTicketUpdates(
  ticketing: Record<string, unknown> | undefined,
  choice: Exclude<RunTicketUpdates, 'custom'>,
): Record<string, unknown> | undefined {
  const create = choice === 'off' ? undefined : ticketing?.createSourceTicket
  const next: Record<string, unknown> = {
    ...(choice === 'off' ? { enabled: false } : {}),
    ...(choice === 'status-sync' || choice === 'subtasks' ? { preset: choice } : {}),
    ...(create ? { createSourceTicket: create } : {}),
  }
  return Object.keys(next).length > 0 ? next : undefined
}

export function createsSourceTicket(ticketing: Record<string, unknown> | undefined): boolean {
  const create = ticketing?.createSourceTicket
  return Boolean(create && typeof create === 'object' && (create as { mode?: unknown }).mode === 'auto')
}

export function withCreateSourceTicket(
  ticketing: Record<string, unknown> | undefined,
  on: boolean,
): Record<string, unknown> | undefined {
  const { createSourceTicket: _create, ...rest } = ticketing ?? {}
  const next = on ? { ...rest, createSourceTicket: { mode: 'auto' } } : rest
  return Object.keys(next).length > 0 ? next : undefined
}

/** `params` additions for POST /jobs. */
export function runTicketParams(run: Pick<RunDraft, 'trackerRef' | 'ticketing'>): Record<string, unknown> {
  const ref = run.trackerRef?.externalId.trim() ? run.trackerRef : undefined
  return {
    ...(ref
      ? {
          trackerRef: {
            kind: 'ticket',
            externalId: ref.externalId.trim(),
            ...(ref.pluginId ? { pluginId: ref.pluginId } : {}),
            ...(ref.url ? { url: ref.url } : {}),
          },
        }
      : {}),
    ...(run.ticketing ? { ticketing: run.ticketing } : {}),
  }
}

export function parseRun(assistantMessage: string, knownWorkflowPaths: string[]): RunDraft | null {
  const match = assistantMessage.match(/<run>\s*([\s\S]*?)\s*<\/run>/i)
  if (!match?.[1]) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1].trim())
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>

  const repo = typeof obj.repo === 'string' ? obj.repo.trim() : ''
  const serviceName = typeof obj.serviceName === 'string' ? obj.serviceName.trim() : ''
  const description = typeof obj.description === 'string' ? obj.description.trim() : ''
  const workflowPath = typeof obj.workflowPath === 'string' ? obj.workflowPath.trim() : ''
  const interactive = obj.interactive !== false

  if (!repo || description.length < 20) return null
  if (!knownWorkflowPaths.includes(workflowPath)) return null

  let reviewers = ''
  if (Array.isArray(obj.reviewers)) {
    reviewers = obj.reviewers
      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      .join(', ')
  } else if (typeof obj.reviewers === 'string') {
    reviewers = obj.reviewers.trim()
  }

  const trackerRef = parseTrackerRef(obj.trackerRef)
  const ticketing = parseTicketing(obj.ticketing)

  return {
    repo,
    serviceName: serviceName || repo.split('/').pop() || repo,
    description,
    reviewers,
    workflowPath,
    interactive,
    ...(trackerRef ? { trackerRef } : {}),
    ...(ticketing ? { ticketing } : {}),
  }
}
