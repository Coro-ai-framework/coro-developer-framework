import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FilePlus2,
  FileMinus2,
  FileDiff,
  FileSymlink,
  ListTree,
} from 'lucide-react'
import type { ParsedDiffFile, ParsedDiffHunk, DiffFileStatus } from '../lib/job-diff'
import { cn } from '../lib/utils'

export interface DiffViewProps {
  files: ParsedDiffFile[]
  truncated?: boolean
  /** Show the changed-files overview map above the diffs (default: true). */
  showFileMap?: boolean
}

export default function DiffView({ files, truncated, showFileMap = true }: DiffViewProps) {
  // Per-file open state, keyed by index. Reset when the file set changes (a new
  // diff arrived). `files` is referentially stable across polls when the patch
  // text is unchanged, so manual toggles survive polling.
  const [open, setOpen] = useState<boolean[]>(() => files.map(() => false))
  useEffect(() => {
    setOpen(files.map(() => false))
  }, [files])

  const cardRefs = useRef<(HTMLDivElement | null)[]>([])

  const setAll = useCallback((v: boolean) => setOpen(files.map(() => v)), [files])
  const toggle = useCallback(
    (i: number) => setOpen(prev => prev.map((o, idx) => (idx === i ? !o : o))),
    [],
  )
  const jumpTo = useCallback((i: number) => {
    setOpen(prev => prev.map((o, idx) => (idx === i ? true : o)))
    requestAnimationFrame(() =>
      cardRefs.current[i]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }),
    )
  }, [])

  if (files.length === 0) return null

  const allOpen = open.length > 0 && open.every(Boolean)
  const allClosed = open.every(o => !o)

  return (
    <div className="space-y-3">
      {showFileMap && files.length > 1 ? (
        <FileMap
          files={files}
          onJump={jumpTo}
          onExpandAll={() => setAll(true)}
          onCollapseAll={() => setAll(false)}
          allOpen={allOpen}
          allClosed={allClosed}
        />
      ) : null}

      {files.map((file, i) => (
        <DiffFileCard
          key={i}
          file={file}
          open={open[i] ?? false}
          onToggle={() => toggle(i)}
          cardRef={el => {
            cardRefs.current[i] = el
          }}
        />
      ))}

      {truncated ? (
        <p className="rounded-lg border border-warning-500/20 bg-warning-500/5 px-3 py-2 text-xs text-warning-300">
          This diff is very large and was truncated. Open the full PR on the SCM to review every line.
        </p>
      ) : null}
    </div>
  )
}

/** Compact overview of every changed file. Clicking a row expands + scrolls to it. */
function FileMap({
  files,
  onJump,
  onExpandAll,
  onCollapseAll,
  allOpen,
  allClosed,
}: {
  files: ParsedDiffFile[]
  onJump: (i: number) => void
  onExpandAll: () => void
  onCollapseAll: () => void
  allOpen: boolean
  allClosed: boolean
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-canvas/40">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium text-fg-muted">
          <ListTree className="size-3.5 text-fg-subtle" />
          {files.length} files changed
        </div>
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={onExpandAll}
            disabled={allOpen}
            className="text-fg-subtle transition-colors hover:text-fg disabled:opacity-40"
          >
            Expand all
          </button>
          <span className="text-line">·</span>
          <button
            type="button"
            onClick={onCollapseAll}
            disabled={allClosed}
            className="text-fg-subtle transition-colors hover:text-fg disabled:opacity-40"
          >
            Collapse all
          </button>
        </div>
      </div>
      <ul className="max-h-56 overflow-y-auto py-1">
        {files.map((f, i) => (
          <li key={i}>
            <button
              type="button"
              onClick={() => onJump(i)}
              className="flex w-full items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-overlay/40"
            >
              <StatusIcon status={f.status} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">
                {f.status === 'renamed' && f.oldPath !== f.newPath ? `${f.oldPath} → ${f.newPath}` : f.path}
              </span>
              {f.additions > 0 ? (
                <span className="font-mono text-xs text-success-400">+{f.additions}</span>
              ) : null}
              {f.deletions > 0 ? (
                <span className="font-mono text-xs text-danger-400">−{f.deletions}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function DiffFileCard({
  file,
  open,
  onToggle,
  cardRef,
}: {
  file: ParsedDiffFile
  open: boolean
  onToggle: () => void
  cardRef: (el: HTMLDivElement | null) => void
}) {
  return (
    <div ref={cardRef} className="scroll-mt-4 overflow-hidden rounded-xl border border-line bg-canvas/40">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-overlay/40"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-fg-subtle" />
        )}
        <StatusIcon status={file.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
          {file.status === 'renamed' && file.oldPath !== file.newPath ? (
            <>
              <span className="text-fg-subtle">{file.oldPath} → </span>
              {file.newPath}
            </>
          ) : (
            file.path
          )}
        </span>
        {file.additions > 0 ? (
          <span className="font-mono text-xs text-success-400">+{file.additions}</span>
        ) : null}
        {file.deletions > 0 ? (
          <span className="font-mono text-xs text-danger-400">−{file.deletions}</span>
        ) : null}
      </button>

      {open ? (
        file.binary ? (
          <div className="border-t border-line px-3 py-3 text-xs text-fg-subtle">Binary file not shown.</div>
        ) : file.hunks.length === 0 ? (
          <div className="border-t border-line px-3 py-3 text-xs text-fg-subtle">No textual changes.</div>
        ) : (
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full border-collapse font-mono text-xs leading-5">
              <tbody>
                {file.hunks.map((hunk, hi) => (
                  <HunkRows key={hi} hunk={hunk} />
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </div>
  )
}

function HunkRows({ hunk }: { hunk: ParsedDiffHunk }) {
  return (
    <>
      <tr className="bg-overlay/40 text-fg-subtle">
        <td className="select-none px-2 text-right align-top" />
        <td className="select-none px-2 text-right align-top" />
        <td className="whitespace-pre-wrap break-words px-3 py-0.5">{hunk.header}</td>
      </tr>
      {hunk.lines.map((line, li) => (
        <tr
          key={li}
          className={cn(
            line.type === 'add' && 'bg-success-500/10',
            line.type === 'del' && 'bg-danger-500/10',
          )}
        >
          <td className="w-[1%] select-none whitespace-nowrap px-2 text-right align-top text-fg-subtle/70">
            {line.oldNo ?? ''}
          </td>
          <td className="w-[1%] select-none whitespace-nowrap px-2 text-right align-top text-fg-subtle/70">
            {line.newNo ?? ''}
          </td>
          <td
            className={cn(
              'whitespace-pre-wrap break-words px-3 align-top',
              line.type === 'add' && 'text-success-400',
              line.type === 'del' && 'text-danger-400',
              line.type === 'context' && 'text-fg-muted',
            )}
          >
            <span className="select-none text-fg-subtle/60">
              {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}
            </span>
            {line.text}
          </td>
        </tr>
      ))}
    </>
  )
}

function StatusIcon({ status }: { status: DiffFileStatus }) {
  const cls = 'size-3.5 shrink-0'
  switch (status) {
    case 'added':
      return <FilePlus2 className={cn(cls, 'text-success-400')} />
    case 'deleted':
      return <FileMinus2 className={cn(cls, 'text-danger-400')} />
    case 'renamed':
      return <FileSymlink className={cn(cls, 'text-accent-300')} />
    default:
      return <FileDiff className={cn(cls, 'text-fg-muted')} />
  }
}
