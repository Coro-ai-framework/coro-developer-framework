import { readFile } from 'fs/promises'
import type { ExternalRef, ReviewEvent, ReviewEventKind } from '@coro-ai/cloud-protocol'
import { parsePrUrl } from './id'

const ACTION_KIND: Record<string, ReviewEventKind> = {
  opened: 'review-requested',
  synchronize: 'commits-pushed',
  ready_for_review: 'ready-for-review',
  converted_to_draft: 'converted-to-draft',
  review_requested: 'review-requested',
  review_request_removed: 'review-request-removed',
  closed: 'closed',
  reopened: 'reopened',
}

/**
 * Maps a GitHub Actions event payload (or an explicit `--pr` URL) onto
 * ReviewEvents. Other CI systems pass `--pr` and a synthetic `manual` event.
 */
export async function eventsFromCi(args: {
  eventPath?: string
  eventName?: string
  prUrl?: string
}): Promise<ReviewEvent[]> {
  if (args.prUrl && !args.eventPath) {
    const ref = parsePrUrl(args.prUrl)
    if (!ref) return []
    return [manual(ref)]
  }
  if (!args.eventPath) return []
  const raw = JSON.parse(await readFile(args.eventPath, 'utf8')) as Record<string, unknown>
  const name = args.eventName ?? ''
  if (name === 'issue_comment' || name === 'pull_request_review_comment') {
    const ref = refFromPayload(raw)
    if (!ref) return []
    const comment = (raw['comment'] ?? {}) as Record<string, unknown>
    return [{
      kind: 'comment',
      prRef: ref,
      actor: actorOf(comment),
      at: new Date().toISOString(),
      data: { body: comment['body'], id: comment['id'] },
      source: 'ci',
    }]
  }
  const ref = refFromPayload(raw)
  if (!ref) return args.prUrl && parsePrUrl(args.prUrl) ? [manual(parsePrUrl(args.prUrl)!)] : []
  const action = String(raw['action'] ?? '')
  let kind = ACTION_KIND[action] ?? 'commits-pushed'
  if (action === 'closed' && (raw['pull_request'] as { merged?: boolean } | undefined)?.merged) kind = 'merged'
  return [{
    kind,
    prRef: ref,
    at: new Date().toISOString(),
    data: { action, headSha: headShaOf(raw) },
    source: 'ci',
  }]
}

function manual(ref: ExternalRef): ReviewEvent {
  return { kind: 'manual', prRef: ref, at: new Date().toISOString(), data: {}, source: 'manual' }
}

function refFromPayload(raw: Record<string, unknown>): ExternalRef | null {
  const pr = (raw['pull_request'] ?? raw['issue']) as Record<string, unknown> | undefined
  const repo = raw['repository'] as { full_name?: string } | undefined
  const number = pr?.['number']
  if (!repo?.full_name || number === undefined) return null
  return {
    kind: 'pull_request',
    pluginId: 'github',
    repoKey: repo.full_name,
    externalId: String(number),
    url: typeof pr?.['html_url'] === 'string' ? pr['html_url'] as string : undefined,
  }
}

function actorOf(comment: Record<string, unknown>): string | undefined {
  const user = comment['user'] as { login?: string } | undefined
  return user?.login
}

function headShaOf(raw: Record<string, unknown>): string | undefined {
  const pr = raw['pull_request'] as { head?: { sha?: string } } | undefined
  return pr?.head?.sha
}
