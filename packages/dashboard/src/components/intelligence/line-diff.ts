// ── Line Diff ──────────────────────────────────────────────────────────────
//
// Tiny dependency-free unified-style line diff used by the file inspector
// to show "what did this layer change versus the layer underneath".
//
// Algorithm: classic Myers-style LCS table over lines, then a back-trace
// emitting `=` (unchanged), `-` (removed), `+` (added). For the file sizes
// we deal with (a few hundred lines at most) the O(n·m) memory cost is fine
// and well below the threshold where we'd want a real diff library.
//
// Output is HTML, ready to drop into dangerouslySetInnerHTML. Each line is
// individually escaped so user content can never inject markup.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

type Op = { kind: '=' | '-' | '+'; left: string | null; right: string | null }
type RenderRow = { op: Op; leftNo: number | null; rightNo: number | null }

export type DiffSummary = { added: number; removed: number; unchanged: number }

export function summarizeDiff(before: string, after: string): DiffSummary {
  const beforeLines = before.replace(/\r\n/g, '\n').split('\n')
  const afterLines = after.replace(/\r\n/g, '\n').split('\n')
  const ops = diffLines(beforeLines, afterLines)
  let added = 0
  let removed = 0
  let unchanged = 0
  for (const op of ops) {
    if (op.kind === '+') added++
    else if (op.kind === '-') removed++
    else unchanged++
  }
  return { added, removed, unchanged }
}

function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length
  const m = b.length
  // dp[i][j] = LCS length of a[0..i) and b[0..j)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  const ops: Op[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ kind: '=', left: a[i - 1], right: b[j - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ kind: '+', left: null, right: b[j - 1] })
      j--
    } else {
      ops.push({ kind: '-', left: a[i - 1], right: null })
      i--
    }
  }
  ops.reverse()
  return ops
}

/**
 * Render a `before` → `after` diff as HTML rows. Trims runs of unchanged
 * lines longer than 6 to a single "…" separator so the inspector stays
 * readable on large files.
 */
export function renderLineDiff(before: string, after: string): string {
  const beforeLines = before.replace(/\r\n/g, '\n').split('\n')
  const afterLines = after.replace(/\r\n/g, '\n').split('\n')
  const ops = diffLines(beforeLines, afterLines)

  // Walk ops once and assign 1-based line numbers per side.
  const rows: RenderRow[] = []
  let leftNo = 0
  let rightNo = 0
  for (const op of ops) {
    if (op.kind === '=') {
      leftNo++
      rightNo++
      rows.push({ op, leftNo, rightNo })
    } else if (op.kind === '-') {
      leftNo++
      rows.push({ op, leftNo, rightNo: null })
    } else {
      rightNo++
      rows.push({ op, leftNo: null, rightNo })
    }
  }
  const gutterWidth = String(Math.max(leftNo, rightNo, 1)).length

  // Collapse long unchanged runs.
  const CONTEXT = 3
  const rendered: string[] = []
  let runStart = -1
  for (let k = 0; k <= rows.length; k++) {
    const row = rows[k]
    const isEqual = row?.op.kind === '='
    if (isEqual && runStart === -1) runStart = k
    if (!isEqual && runStart !== -1) {
      const runEnd = k
      const runLen = runEnd - runStart
      const isLeading = runStart === 0
      const headKeep = isLeading ? 0 : CONTEXT
      const tailKeep = CONTEXT
      if (runLen > headKeep + tailKeep + 1) {
        for (let x = runStart; x < runStart + headKeep; x++)
          rendered.push(renderRow(rows[x], gutterWidth))
        rendered.push(renderHunkSeparator(runLen - headKeep - tailKeep, gutterWidth))
        for (let x = runEnd - tailKeep; x < runEnd; x++)
          rendered.push(renderRow(rows[x], gutterWidth))
      } else {
        for (let x = runStart; x < runEnd; x++) rendered.push(renderRow(rows[x], gutterWidth))
      }
      runStart = -1
    }
    if (row && !isEqual) rendered.push(renderRow(row, gutterWidth))
  }
  // Handle trailing unchanged run
  if (runStart !== -1) {
    const runLen = rows.length - runStart
    const headKeep = runStart === 0 ? 0 : CONTEXT
    if (runLen > headKeep + 1) {
      for (let x = runStart; x < runStart + headKeep; x++)
        rendered.push(renderRow(rows[x], gutterWidth))
      rendered.push(renderHunkSeparator(runLen - headKeep, gutterWidth))
    } else {
      for (let x = runStart; x < rows.length; x++) rendered.push(renderRow(rows[x], gutterWidth))
    }
  }

  if (rendered.length === 0) {
    return `<div class="p-4 text-sm text-fg-muted">Files are identical.</div>`
  }
  return `<div class="font-mono text-[12px] leading-[1.55]">${rendered.join('')}</div>`
}

function renderHunkSeparator(count: number, gutterWidth: number): string {
  const gw = `${gutterWidth + 1}ch`
  return `<div class="flex items-center border-y border-line bg-overlay/40 text-[10px] uppercase tracking-wide text-fg-subtle"><span style="width:${gw}" class="shrink-0 select-none border-r border-line py-1 text-center opacity-60">⋯</span><span style="width:${gw}" class="shrink-0 select-none border-r border-line py-1 text-center opacity-60">⋯</span><span class="px-3 py-1">… ${count} unchanged line${count === 1 ? '' : 's'} …</span></div>`
}

function renderRow(row: RenderRow, gutterWidth: number): string {
  const { op, leftNo, rightNo } = row
  const text = op.kind === '+' ? op.right ?? '' : op.left ?? ''

  let rowBg = ''
  let accent = 'border-l-[3px] border-transparent'
  let sigilCls = 'text-fg-subtle'
  let sigil = ' '
  if (op.kind === '+') {
    rowBg = 'bg-success-500/15'
    accent = 'border-l-[3px] border-success-500/70'
    sigilCls = 'font-bold text-success-400'
    sigil = '+'
  } else if (op.kind === '-') {
    rowBg = 'bg-danger-500/15'
    accent = 'border-l-[3px] border-danger-500/70'
    sigilCls = 'font-bold text-danger-400'
    sigil = '−'
  }

  const gw = `${gutterWidth + 1}ch`
  const leftLabel = leftNo === null ? '' : String(leftNo)
  const rightLabel = rightNo === null ? '' : String(rightNo)
  const gutterCls =
    'shrink-0 select-none border-r border-line/60 px-1 py-0.5 text-right text-[10px] tabular-nums text-fg-subtle/70'
  const dataAttr =
    op.kind === '+' ? ' data-diff-kind="add"' : op.kind === '-' ? ' data-diff-kind="del"' : ''

  return (
    `<div${dataAttr} class="${rowBg} ${accent} flex items-stretch">` +
    `<span style="width:${gw}" class="${gutterCls}">${escapeHtml(leftLabel)}</span>` +
    `<span style="width:${gw}" class="${gutterCls}">${escapeHtml(rightLabel)}</span>` +
    `<span class="w-5 shrink-0 select-none py-0.5 text-center ${sigilCls}">${sigil}</span>` +
    `<span class="flex-1 whitespace-pre-wrap break-words py-0.5 pr-3">${escapeHtml(text)}</span>` +
    `</div>`
  )
}
