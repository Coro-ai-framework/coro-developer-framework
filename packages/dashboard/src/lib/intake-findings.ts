// Plan mode's investigation write-up is a markdown document, not a chat
// sentence. The agent emits it in <findings>…</findings>; the dashboard
// hides the tag and renders a Findings card. A conservative heading-based
// heuristic covers turns that already write the report as markdown but
// forget the tag.

const FINDINGS_TAG = /<findings>\s*([\s\S]*?)\s*<\/findings>/i

export function parseFindings(assistantMessage: string): string | null {
  const match = assistantMessage.match(FINDINGS_TAG)
  const body = match?.[1]?.trim() ?? ''
  return body.length > 0 ? body : null
}

/**
 * First heading, else the first non-empty line — used as the collapsed
 * card summary so a long report still has a scannable title.
 */
export function findingsTitle(markdown: string): string {
  const heading = markdown.match(/^#{1,6}\s+(.+)$/m)
  if (heading?.[1]) return heading[1].trim()
  const first = markdown.split('\n').map(l => l.trim()).find(Boolean) ?? ''
  const cleaned = first.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '')
  if (!cleaned) return 'Findings'
  return cleaned.length > 88 ? `${cleaned.slice(0, 85)}…` : cleaned
}

/**
 * True when untagged prose is a markdown write-up rather than a narrating
 * sentence. Requires a heading so "Let me look at the decode path." never
 * becomes a card.
 */
export function looksLikeFindingsReport(text: string): boolean {
  const t = text.trim()
  if (t.length < 80) return false
  return /^#{1,6}\s+\S/m.test(t)
}
