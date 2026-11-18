// Absolute local paths in plan-mode prose, so the dashboard can offer to open
// them. Matching is deliberately narrow — only paths under well-known roots —
// so API routes like `/jobs/:id/open` stay plain text.

const SEGMENT = String.raw`[^\s'"\x60<>()[\]{}|,;:*?]+`
const PATH_RE = new RegExp(
  String.raw`(^|[\s(\[{'"\x60])((?:~|/(?:Users|home|root|private|var|tmp|Volumes|mnt|opt|srv))/${SEGMENT}|[A-Za-z]:[\\/]${SEGMENT})`,
  'g',
)

export interface TextSegment {
  text: string
  /** Set when this segment is a local path. */
  path?: string
}

export function splitLocalPaths(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let cursor = 0
  PATH_RE.lastIndex = 0
  for (let match = PATH_RE.exec(text); match; match = PATH_RE.exec(text)) {
    const path = match[2]!.replace(/[.!]+$/, '')
    const start = match.index + match[1]!.length
    if (start > cursor) segments.push({ text: text.slice(cursor, start) })
    segments.push({ text: path, path })
    cursor = start + path.length
    PATH_RE.lastIndex = cursor
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) })
  return segments
}
