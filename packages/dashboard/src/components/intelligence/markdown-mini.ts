// ── Mini Markdown Renderer ─────────────────────────────────────────────────
//
// A deliberately tiny, dependency-free markdown renderer used by the
// Intelligence file inspector. Handles only the constructs that show up
// in agent / workflow / skill / memory MD files:
//
//   • YAML front-matter block         → rendered as a labeled <pre>
//   • # / ## / ### headings           → <h1>/<h2>/<h3>
//   • Fenced ```lang code``` blocks   → <pre><code>
//   • Inline `code`, **bold**, *em*   → <code>/<strong>/<em>
//   • - / * unordered lists           → <ul><li>
//   • Numbered 1. lists               → <ol><li>
//   • GitHub-style pipe tables        → <table>
//   • Blank-line-separated paragraphs → <p>
//
// Everything else is escaped and rendered as plain text. Callers are free
// to pass output to dangerouslySetInnerHTML — escaping is enforced on every
// substitution path.
//
// We intentionally avoid an external lib (`marked`, `markdown-it`) to keep
// the dashboard bundle lean. If we ever need a richer renderer, swap to
// `marked` and delete this file.

const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n?/
const FENCE_RE = /^```([a-zA-Z0-9_-]*)\n([\s\S]*?)\n```/

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderInline(line: string): string {
  let out = escapeHtml(line)
  // `code`
  out = out.replace(/`([^`]+)`/g, (_, m) => `<code class="rounded bg-overlay px-1 py-0.5 text-[11px]">${m}</code>`)
  // **bold**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold text-fg">$1</strong>')
  // *italic* — only when not already part of **
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  return out
}

type ColumnAlign = 'left' | 'center' | 'right'

const ALIGN_CLASS: Record<ColumnAlign, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
}

/**
 * Split a GitHub-flavored table row into cells. Leading and trailing pipes
 * are the row's borders, not extra cells. Pipes inside inline code or
 * escaped as `\|` stay in the cell.
 */
function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null
  let body = trimmed
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)

  const cells: string[] = []
  let buf = ''
  let inCode = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\' && body[i + 1] === '|' && !inCode) {
      buf += '|'
      i++
      continue
    }
    if (ch === '`') {
      inCode = !inCode
      buf += ch
      continue
    }
    if (ch === '|' && !inCode) {
      cells.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  cells.push(buf.trim())
  return cells
}

function parseDelimiter(line: string): ColumnAlign[] | null {
  const cells = splitTableRow(line)
  if (!cells || cells.length === 0) return null
  const aligns: ColumnAlign[] = []
  for (const cell of cells) {
    const match = /^(:)?(-+)(:)?$/.exec(cell.replace(/\s+/g, ''))
    if (!match) return null
    if (match[1] && match[3]) aligns.push('center')
    else if (match[3]) aligns.push('right')
    else aligns.push('left')
  }
  return aligns
}

function isIndexHeader(cell: string): boolean {
  const plain = cell.replace(/[`*_]/g, '').trim()
  return plain === '#' || plain === 'No' || plain === 'No.'
}

function blocksTable(line: string): boolean {
  const trimmed = line.trim()
  return /^#{1,6}\s/.test(trimmed) || /^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed) || trimmed.startsWith('```')
}

function renderTable(headers: string[], aligns: ColumnAlign[], rows: string[][]): string {
  const head = headers
    .map((cell, i) => {
      const index = isIndexHeader(cell)
      const cls = [
        'border border-line-strong bg-overlay/70 py-2 align-top font-medium text-fg',
        index ? 'w-px whitespace-nowrap px-2.5 text-center' : `px-3 ${ALIGN_CLASS[aligns[i] ?? 'left']}`,
      ].join(' ')
      return `<th scope="col" class="${cls}">${renderInline(cell)}</th>`
    })
    .join('')

  const body = rows
    .map(row => {
      const cells = row
        .map((cell, i) => {
          const index = isIndexHeader(headers[i] ?? '')
          const cls = [
            'border border-line-strong py-2 align-top text-fg-muted [overflow-wrap:anywhere]',
            index ? 'w-px whitespace-nowrap px-2.5 text-center' : `px-3 ${ALIGN_CLASS[aligns[i] ?? 'left']}`,
          ].join(' ')
          return `<td class="${cls}">${renderInline(cell)}</td>`
        })
        .join('')
      return `<tr class="even:bg-white/[0.03]">${cells}</tr>`
    })
    .join('')

  return `<div class="max-w-full overflow-x-auto"><table class="w-full border-collapse text-left text-sm leading-6"><thead><tr>${head}</tr></thead>${
    body ? `<tbody>${body}</tbody>` : ''
  }</table></div>`
}

function tryConsumeTable(lines: string[], start: number): { html: string; next: number } | null {
  if (start + 1 >= lines.length) return null
  const headerLine = lines[start]
  if (!headerLine.includes('|') || blocksTable(headerLine) || parseDelimiter(headerLine)) return null
  const header = splitTableRow(headerLine)
  const aligns = parseDelimiter(lines[start + 1])
  if (!header || !aligns || header.length === 0 || header.length !== aligns.length) return null

  const rows: string[][] = []
  let i = start + 2
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('```') || !line.includes('|')) break
    const cells = splitTableRow(line)
    if (!cells) break
    const fitted = cells.slice(0, aligns.length)
    while (fitted.length < aligns.length) fitted.push('')
    rows.push(fitted)
    i++
  }
  return { html: renderTable(header, aligns, rows), next: i }
}

export function renderInlineMarkdown(input: string): string {
  let src = input.replace(/\r\n/g, '\n')
  const out: string[] = []

  // Front-matter
  const fm = FRONT_MATTER_RE.exec(src)
  if (fm) {
    out.push(
      `<div class="rounded-md border border-line bg-overlay/40 p-2"><div class="mb-1 text-[10px] uppercase tracking-wide text-fg-subtle">front matter</div><pre class="whitespace-pre-wrap font-mono text-[11px] leading-5 text-fg-muted">${escapeHtml(
        fm[1],
      )}</pre></div>`,
    )
    src = src.slice(fm[0].length)
  }

  let i = 0
  const lines = src.split('\n')

  // Helpers for list flushing
  let listType: 'ul' | 'ol' | null = null
  const listBuf: string[] = []
  function flushList() {
    if (!listType) return
    out.push(
      `<${listType} class="${
        listType === 'ul' ? 'list-disc' : 'list-decimal'
      } space-y-1 pl-5 text-fg">${listBuf.map(item => `<li>${item}</li>`).join('')}</${listType}>`,
    )
    listBuf.length = 0
    listType = null
  }

  // Paragraph buffer
  let para: string[] = []
  function flushPara() {
    if (para.length === 0) return
    out.push(`<p class="text-fg-muted">${para.map(renderInline).join(' ')}</p>`)
    para = []
  }

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code — needs to consume multiple lines, so peek the rest of src.
    const remaining = lines.slice(i).join('\n')
    const fence = FENCE_RE.exec(remaining)
    if (fence && remaining.startsWith(fence[0])) {
      flushPara()
      flushList()
      const lang = fence[1]
      out.push(
        `<pre class="overflow-auto rounded-md border border-line bg-canvas/80 p-3 text-[11px] leading-5"><code data-lang="${escapeHtml(
          lang,
        )}">${escapeHtml(fence[2])}</code></pre>`,
      )
      const consumedLines = fence[0].split('\n').length
      i += consumedLines
      continue
    }

    const table = tryConsumeTable(lines, i)
    if (table) {
      flushPara()
      flushList()
      out.push(table.html)
      i = table.next
      continue
    }

    // Heading
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      flushPara()
      flushList()
      const level = Math.min(heading[1].length, 4)
      const tag = `h${level}`
      const sizes = ['text-lg font-semibold text-fg', 'text-base font-semibold text-fg', 'text-sm font-semibold text-fg', 'text-sm font-medium text-fg']
      out.push(`<${tag} class="${sizes[level - 1]}">${renderInline(heading[2])}</${tag}>`)
      i++
      continue
    }

    // Unordered list
    const ul = /^[-*]\s+(.+)$/.exec(line)
    if (ul) {
      flushPara()
      if (listType !== 'ul') flushList()
      listType = 'ul'
      listBuf.push(renderInline(ul[1]))
      i++
      continue
    }

    // Ordered list
    const ol = /^\d+\.\s+(.+)$/.exec(line)
    if (ol) {
      flushPara()
      if (listType !== 'ol') flushList()
      listType = 'ol'
      listBuf.push(renderInline(ol[1]))
      i++
      continue
    }

    // Blank line: paragraph break
    if (line.trim() === '') {
      flushPara()
      flushList()
      i++
      continue
    }

    // Default: accumulate paragraph
    flushList()
    para.push(line.trim())
    i++
  }

  flushPara()
  flushList()

  return out.join('\n')
}
