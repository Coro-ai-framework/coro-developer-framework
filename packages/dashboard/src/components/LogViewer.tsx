import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine } from 'lucide-react'
import type { LogLine, LogLineType } from '../hooks/useJobStream'
import SegmentedControl from './ui/segmented-control'
import { Button } from './ui/button'
import { cn } from '../lib/utils'

interface LogViewerProps {
  lines: LogLine[]
  className?: string
}

/**
 * Per-line styling. Reduced palette: structural lines (text/tools/thinking)
 * stay neutral; only signal lines (error/result/human/phase) carry color so
 * they stand out from the wash of regular output.
 */
const LINE_STYLES: Record<LogLineType, { textClass: string; accentClass: string; label?: string; dimmed?: boolean }> = {
  text:           { textClass: 'text-fg', accentClass: 'bg-fg-subtle' },
  tool_use:       { textClass: 'text-fg', accentClass: 'bg-accent-400', label: 'Tool' },
  tool_summary:   { textClass: 'text-fg-muted', accentClass: 'bg-fg-subtle', label: 'Summary', dimmed: true },
  thinking:       { textClass: 'text-fg-muted', accentClass: 'bg-fg-subtle', label: 'Thinking', dimmed: true },
  tool_progress:  { textClass: 'text-fg-muted', accentClass: 'bg-fg-subtle', label: 'Progress', dimmed: true },
  error:          { textClass: 'text-danger-400', accentClass: 'bg-danger-400', label: 'Error' },
  result:         { textClass: 'text-success-400', accentClass: 'bg-success-400', label: 'Result' },
  phase:          { textClass: 'text-accent-300', accentClass: 'bg-accent-400', label: 'Phase' },
  insight:        { textClass: 'text-accent-300', accentClass: 'bg-accent-400', label: 'Insight' },
  session_reset:  { textClass: 'text-warning-400', accentClass: 'bg-warning-400', label: 'Reset' },
  webhook:        { textClass: 'text-warning-400', accentClass: 'bg-warning-400', label: 'Webhook' },
  human:          { textClass: 'text-fg', accentClass: 'bg-accent-400', label: 'Developer' },
  system:         { textClass: 'text-fg-subtle', accentClass: 'bg-fg-subtle', label: 'System', dimmed: true },
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
      <div className="my-2 flex items-center gap-3 py-1.5">
        <div className="h-px flex-1 bg-accent-500/20" />
        <span className="rounded-full border border-accent-500/25 bg-accent-500/10 px-3 py-0.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-accent-300">
          {content}
        </span>
        <div className="h-px flex-1 bg-accent-500/20" />
      </div>
    )
  }

  if (line.lineType === 'error') {
    return (
      <div className="my-1 rounded-xl border border-danger-500/25 bg-danger-500/8 px-4 py-2.5">
        <span className={style.textClass}>{content}</span>
      </div>
    )
  }

  if (line.lineType === 'result') {
    return (
      <div className="my-1 rounded-xl border border-success-500/25 bg-success-500/8 px-4 py-2.5">
        <span className={style.textClass}>{content}</span>
      </div>
    )
  }

  if (line.lineType === 'human') {
    const msg = content.replace(/^\[human\]\s*/, '')
    return (
      <div className="my-1 rounded-xl border border-accent-500/25 bg-accent-500/8 px-4 py-2.5">
        <span className="mr-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-300">Developer</span>
        <span className="text-fg">{msg}</span>
      </div>
    )
  }

  if (line.lineType === 'tool_use') {
    const match = content.match(/^→ (\S+)(.*)/)
    if (match) {
      return (
        <span className={style.dimmed ? 'opacity-60' : ''}>
          <span className="text-fg-subtle">→ </span>
          <span className="font-medium text-fg">{match[1]}</span>
          <span className="text-fg-subtle">{match[2]}</span>
        </span>
      )
    }
  }

  return (
    <div className="flex items-start gap-3">
      <span className={cn('mt-1.5 size-1.5 rounded-full shrink-0', style.accentClass, style.dimmed ? 'opacity-50' : '')} />
      <span className={cn(style.textClass, style.dimmed && 'opacity-70')}>
        {style.label ? (
          <span className="mr-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-fg-subtle">
            {style.label}
          </span>
        ) : null}
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

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'main', label: 'Agent' },
  { value: 'tools', label: 'Tools' },
] as const

type LogFilter = (typeof FILTER_OPTIONS)[number]['value']

export default function LogViewer({ lines, className = '' }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const autoScrollRef = useRef(true)
  const [filter, setFilter] = useState<LogFilter>('all')
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

  useEffect(() => {
    if (!autoScroll) return
    const id = requestAnimationFrame(() => {
      if (!autoScrollRef.current || !containerRef.current) return
      programmaticScrollRef.current = true
      scrollLogContainerToBottom(containerRef.current, 'auto')
    })
    return () => { cancelAnimationFrame(id) }
  }, [lines, autoScroll, filter])

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
    <div className={cn('flex flex-col overflow-hidden rounded-2xl border border-line bg-canvas/60', className)}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2.5">
        <SegmentedControl
          options={FILTER_OPTIONS}
          value={filter}
          onChange={setFilter}
          size="sm"
          ariaLabel="Filter log lines"
        />

        <div className="flex items-center gap-3">
          <span className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
            {filteredLines.length} / {lines.length} lines
          </span>

          {!autoScroll ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                autoScrollRef.current = true
                setAutoScroll(true)
                if (containerRef.current) {
                  programmaticScrollRef.current = true
                  scrollLogContainerToBottom(containerRef.current, 'smooth')
                }
              }}
            >
              <ArrowDownToLine />
              Follow
            </Button>
          ) : null}
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={updateAutoScrollFromScroll}
        className="min-h-[280px] max-h-[calc(100vh-320px)] flex-1 overflow-y-auto p-4 font-mono text-[12.5px] leading-relaxed"
      >
        {filteredLines.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-fg-subtle">
            Waiting for log output…
          </div>
        ) : (
          filteredLines.map((line, i) => (
            <div
              key={i}
              className={cn(
                'flex gap-3 animate-fade-in',
                line.lineType === 'phase' ? '' : 'rounded-lg px-2 py-1 hover:bg-overlay/40',
              )}
            >
              {line.lineType !== 'phase' ? (
                <span className="shrink-0 select-none pt-0.5 text-[11px] tabular-nums text-fg-subtle/70">
                  {formatTimestamp(line.timestamp)}
                </span>
              ) : null}
              <div className="min-w-0 flex-1 break-words whitespace-pre-wrap">
                <LineContent line={line} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
