import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FilePlus2, FileMinus2, FileDiff, FileSymlink } from 'lucide-react'
import type { ParsedDiffFile, ParsedDiffHunk, DiffFileStatus } from '../lib/job-diff'
import { cn } from '../lib/utils'

// Above these thresholds we collapse files by default so we never mount tens
// of thousands of DOM nodes at once on an accidental huge diff. Small diffs
// (the common case, bounded by the pr-diff-size guardrail) open expanded.
const AUTO_EXPAND_MAX_FILES = 10
const AUTO_EXPAND_MAX_LINES = 800

export interface DiffViewProps {
  files: ParsedDiffFile[]
  truncated?: boolean
}

export default function DiffView({ files, truncated }: DiffViewProps) {
  const autoExpand = useMemo(() => {
    const totalLines = files.reduce((n, f) => n + f.additions + f.deletions, 0)
    return files.length <= AUTO_EXPAND_MAX_FILES && totalLines <= AUTO_EXPAND_MAX_LINES
  }, [files])

  return (
    <div className="space-y-3">
      {files.map(file => (
        <DiffFileCard key={`${file.oldPath}->${file.newPath}`} file={file} defaultOpen={autoExpand} />
      ))}
      {truncated ? (
        <p className="rounded-lg border border-warning-500/20 bg-warning-500/5 px-3 py-2 text-xs text-warning-300">
          This diff is very large and was truncated. Open the full PR on the SCM to review every line.
        </p>
      ) : null}
    </div>
  )
}

function DiffFileCard({ file, defaultOpen }: { file: ParsedDiffFile; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-canvas/40">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
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
