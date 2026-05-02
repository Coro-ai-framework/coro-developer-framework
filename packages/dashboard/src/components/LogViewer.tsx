import { useEffect, useRef, useState } from 'react'
import type { LogLine, LogLineType } from '../hooks/useJobStream'
import { Button } from './ui/button'
import { cn } from '../lib/utils'

interface LogViewerProps {
  lines: LogLine[]
  className?: string
}

const LINE_STYLES: Record<LogLineType, { textClass: string; accentClass: string; label?: string; dimmed?: boolean }> = {
  text:           { textClass: 'text-slate-100', accentClass: 'bg-slate-600' },
  tool_use:       { textClass: 'text-cyan-100', accentClass: 'bg-cyan-400', label: 'Tool' },
  tool_summary:   { textClass: 'text-slate-400', accentClass: 'bg-slate-500', label: 'Summary', dimmed: true },
  thinking:       { textClass: 'text-slate-400', accentClass: 'bg-violet-400', label: 'Thinking', dimmed: true },
  tool_progress:  { textClass: 'text-slate-400', accentClass: 'bg-cyan-500', label: 'Progress', dimmed: true },
  error:          { textClass: 'text-rose-100', accentClass: 'bg-rose-400', label: 'Error' },
  result:         { textClass: 'text-emerald-100', accentClass: 'bg-emerald-400', label: 'Result' },
  phase:          { textClass: 'text-indigo-100', accentClass: 'bg-indigo-400', label: 'Phase' },
  insight:        { textClass: 'text-violet-100', accentClass: 'bg-violet-400', label: 'Insight' },
  session_reset:  { textClass: 'text-amber-100', accentClass: 'bg-amber-400', label: 'Reset' },
  webhook:        { textClass: 'text-amber-100', accentClass: 'bg-amber-400', label: 'Webhook' },
  human:          { textClass: 'text-sky-100', accentClass: 'bg-sky-400', label: 'Developer' },
  system:         { textClass: 'text-slate-500', accentClass: 'bg-slate-500', label: 'System', dimmed: true },
}

function formatTimestamp(ts: string): string {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

function LineContent({ line }: { line: LogLine }) {
  const style = LINE_STYLES[line.lineType]
  const content = line.content

  if (line.lineType === 'phase') {
    return (
      <div className="flex items-center gap-3 py-2.5 my-2">
        <div className="h-px flex-1 bg-indigo-400/20" />
        <span className="rounded-full border border-indigo-400/20 bg-indigo-400/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-indigo-100">
          {content}
        </span>
        <div className="h-px flex-1 bg-indigo-400/20" />
      </div>
    )
  }

  if (line.lineType === 'error') {
    return (
      <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-2.5 my-1">
        <span className={style.textClass}>{content}</span>
      </div>
    )
  }

  if (line.lineType === 'result') {
    return (
      <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-2.5 my-1">
        <span className={style.textClass}>{content}</span>
      </div>
    )
  }

  if (line.lineType === 'human') {
    const msg = content.replace(/^\[human\]\s*/, '')
    return (
      <div className="rounded-2xl border border-sky-500/20 bg-sky-500/10 px-4 py-2.5 my-1">
        <span className="text-sky-200 text-xs font-semibold uppercase tracking-[0.14em] mr-2">Developer</span>
        <span className={style.textClass}>{msg}</span>
      </div>
    )
  }

  if (line.lineType === 'tool_use') {
    const match = content.match(/^→ (\S+)(.*)/)
    if (match) {
      return (
        <span className={style.dimmed ? 'opacity-60' : ''}>
          <span className="text-zinc-500">→ </span>
          <span className="text-cyan-300 font-medium">{match[1]}</span>
          <span className="text-zinc-500">{match[2]}</span>
        </span>
      )
    }
  }

  return (
    <div className="flex items-start gap-3">
      <span className={cn('mt-1 size-2 rounded-full shrink-0', style.accentClass, style.dimmed ? 'opacity-55' : '')} />
      <span className={`${style.textClass} ${style.dimmed ? 'opacity-65' : ''}`}>
        {style.label ? <span className="mr-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">{style.label}</span> : null}
        {content}
      </span>
    </div>
  )
}

/** Scroll only the log container — never use scrollIntoView on inner nodes, or the window scrolls too. */
function scrollLogContainerToBottom(
  el: HTMLDivElement | null,
  behavior: ScrollBehavior = 'auto',
): void {
  if (!el) return
  el.scrollTo({ top: el.scrollHeight, behavior })
}

function isScrolledToBottom(el: HTMLDivElement, thresholdPx = 64): boolean {
  const { scrollTop, scrollHeight, clientHeight } = el
  return scrollHeight - scrollTop - clientHeight <= thresholdPx
}

export default function LogViewer({ lines, className = '' }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const autoScrollRef = useRef(true)
  const [filter, setFilter] = useState<'all' | 'main' | 'tools'>('all')
  /** Skip one scroll-handler sync right after we programmatically scroll (some browsers coalesce events). */
  const programmaticScrollRef = useRef(false)

  useEffect(() => {
    autoScrollRef.current = autoScroll
  }, [autoScroll])

  const updateAutoScrollFromScroll = () => {
    const el = containerRef.current
    if (!el) return
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false
      return
    }
    const atBottom = isScrolledToBottom(el)
    autoScrollRef.current = atBottom
    setAutoScroll(atBottom)
  }

  // New lines: only move the *log* scroll position when the user is following the tail.
  // Never use scrollIntoView on a child — it scrolls the window and yanks the page.
  useEffect(() => {
    if (!autoScroll) return
    // After paint so scrollHeight reflects new log lines.
    const id = requestAnimationFrame(() => {
      if (!autoScrollRef.current || !containerRef.current) return
      programmaticScrollRef.current = true
      scrollLogContainerToBottom(containerRef.current, 'auto')
    })
    return () => { cancelAnimationFrame(id) }
  }, [lines, autoScroll, filter])

  // When following the tail, stay pinned if the log panel resizes.
  useEffect(() => {
    const el = containerRef.current
    if (!el || !autoScroll) return
    const ro = new ResizeObserver(() => {
      if (!containerRef.current || !autoScrollRef.current) return
      programmaticScrollRef.current = true
      scrollLogContainerToBottom(containerRef.current, 'auto')
    })
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [autoScroll])

  const TOOL_TYPES: LogLineType[] = ['tool_use', 'tool_summary', 'tool_progress', 'thinking', 'system']
  const MAIN_TYPES: LogLineType[] = ['text', 'phase', 'error', 'result', 'insight', 'session_reset', 'webhook', 'human']

  const filteredLines = lines.filter(line => {
    if (filter === 'all') return true
    if (filter === 'main') return MAIN_TYPES.includes(line.lineType)
    if (filter === 'tools') return TOOL_TYPES.includes(line.lineType)
    return true
  })

  return (
    <div className={`flex flex-col overflow-hidden rounded-2xl border border-white/8 bg-slate-950/92 ${className}`}>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 border-b border-white/8 px-4 py-3">
        <div className="flex items-center gap-1">
          {(['all', 'main', 'tools'] as const).map(f => (
            <Button
              key={f}
              onClick={() => setFilter(f)}
              variant={filter === f ? 'secondary' : 'ghost'}
              size="sm"
              className={`h-8 rounded-full px-3 text-xs ${
                filter === f
                  ? 'bg-white/10 text-white'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {f === 'all' ? 'All' : f === 'main' ? 'Agent' : 'Tools'}
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs uppercase tracking-[0.14em] text-slate-500">
            {filteredLines.length} / {lines.length} lines
          </span>

          {!autoScroll && (
            <Button
              type="button"
              onClick={() => {
                autoScrollRef.current = true
                setAutoScroll(true)
                if (containerRef.current) {
                  programmaticScrollRef.current = true
                  scrollLogContainerToBottom(containerRef.current, 'smooth')
                }
              }}
              size="sm"
            >
              ↓ Follow
            </Button>
          )}
        </div>
      </div>

      {/* Log content */}
      <div
        ref={containerRef}
        onScroll={updateAutoScrollFromScroll}
        className="flex-1 overflow-y-auto p-4 font-mono text-[13px] leading-relaxed min-h-[280px] max-h-[calc(100vh-280px)]"
      >
        {filteredLines.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-slate-500">
            Waiting for log output...
          </div>
        ) : (
          filteredLines.map((line, i) => (
            <div
              key={i}
              className={`flex gap-3 animate-fade-in ${
                line.lineType === 'phase' ? '' : 'rounded-xl px-2 py-1.5 hover:bg-white/[0.035]'
              }`}
            >
              {line.lineType !== 'phase' && (
                <span className="select-none shrink-0 pt-0.5 text-xs leading-relaxed tabular-nums text-slate-600">
                  {formatTimestamp(line.timestamp)}
                </span>
              )}
              <div className="flex-1 min-w-0 break-words whitespace-pre-wrap">
                <LineContent line={line} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
