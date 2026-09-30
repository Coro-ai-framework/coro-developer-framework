import type { ActivityItem } from '../components/activity/types'
import { displayContent } from '../components/activity/message-block'
import { looksLikeFindingsReport, parseFindings } from './intake-findings'
import { parseReadiness, type Readiness } from './intake-readiness'
import { parseRun } from './intake-run'

/**
 * A reload mid-investigation hydrates the last snapshot. That snapshot can
 * miss the reply the runner recorded after the browser disconnected, so the
 * feed is completed from the stored turn before anyone can answer it.
 */
export function recoverIntakeReply(
  items: ActivityItem[],
  turns: unknown,
  knownWorkflowPaths: string[],
): { items: ActivityItem[]; readiness: Readiness | null } {
  const assistant = lastRecordedAssistant(turns)
  if (!assistant) return { items, readiness: null }

  const readiness = parseReadiness(assistant)
  const relation = assistantRelation(items, assistant)
  let next = items
  if (relation === 'missing' || relation === 'prefix') {
    next = replaceTrailingAssistant(items, assistant, relation)
  }
  next = ensureFindingsCard(next, assistant)
  next = ensureRunCard(next, assistant, knownWorkflowPaths, readiness)
  return { items: next, readiness }
}

function lastRecordedAssistant(turns: unknown): string {
  if (!Array.isArray(turns) || turns.length === 0) return ''
  const last = turns[turns.length - 1]
  if (!last || typeof last !== 'object') return ''
  const assistant = (last as { assistant?: unknown }).assistant
  return typeof assistant === 'string' ? assistant.trim() : ''
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function lastUserIndex(items: ActivityItem[]): number {
  let index = -1
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item?.kind === 'message' && item.role === 'user') index = i
  }
  return index
}

function trailingAssistantParts(items: ActivityItem[]): { indexes: number[]; parts: string[] } {
  const indexes: number[] = []
  const parts: string[] = []
  for (let i = lastUserIndex(items) + 1; i < items.length; i++) {
    const item = items[i]
    if (item?.kind !== 'message' || item.role !== 'assistant') continue
    indexes.push(i)
    parts.push(item.text)
  }
  return { indexes, parts }
}

function assistantRelation(items: ActivityItem[], assistant: string): 'missing' | 'full' | 'prefix' | 'other' {
  const { parts } = trailingAssistantParts(items)
  if (parts.length === 0) return 'missing'
  const recorded = compact(assistant)
  const shown = [compact(parts.join('')), compact(parts.join(' '))]
  if (shown.some(text => text === recorded)) return 'full'
  if (shown.some(text => text.length > 0 && recorded.startsWith(text))) return 'prefix'
  return 'other'
}

function replaceTrailingAssistant(
  items: ActivityItem[],
  assistant: string,
  relation: 'missing' | 'prefix',
): ActivityItem[] {
  const visible = displayContent('assistant', assistant)
  const drop = relation === 'prefix' ? new Set(trailingAssistantParts(items).indexes) : new Set<number>()
  const kept = items.filter((_, index) => !drop.has(index))
  if (!visible) return kept
  return [
    ...kept,
    { kind: 'message', id: `recovered-assistant-${kept.length}`, role: 'assistant', text: assistant },
  ]
}

function ensureFindingsCard(items: ActivityItem[], assistant: string): ActivityItem[] {
  const visible = displayContent('assistant', assistant)
  const tagged = parseFindings(assistant)
  const markdown = tagged ?? (visible && looksLikeFindingsReport(visible) ? visible : null)
  if (!markdown) return items
  const already = items.some(item => {
    if (item.kind !== 'card' || item.card.type !== 'findings') return false
    const data = item.card.data as { markdown?: string }
    return data.markdown === markdown
  })
  if (already) return items
  const superseded = items.map(item => {
    if (item.kind !== 'card' || item.card.type !== 'findings') return item
    const data = item.card.data as { state?: string }
    if (data.state !== 'current') return item
    return { ...item, card: { ...item.card, data: { ...data, state: 'superseded' } } }
  })
  return [
    ...superseded,
    {
      kind: 'card',
      id: `recovered-findings-${superseded.length}`,
      card: { type: 'findings', data: { markdown, state: 'current' } },
    },
  ]
}

function ensureRunCard(
  items: ActivityItem[],
  assistant: string,
  knownWorkflowPaths: string[],
  readiness: Readiness | null,
): ActivityItem[] {
  if (readiness?.state === 'investigating') return items
  if (items.some(item => item.kind === 'card' && item.card.type === 'run')) return items
  const parsed = parseRun(assistant, knownWorkflowPaths)
  if (!parsed) return items
  return [
    ...items,
    {
      kind: 'card',
      id: `recovered-run-${items.length}`,
      card: { type: 'run', data: { run: parsed, state: 'draft' } },
    },
  ]
}
