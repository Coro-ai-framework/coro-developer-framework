import { useEffect, useRef, useState } from 'react'
import type { LogLine, LogLineType } from '../hooks/useJobStream'

interface LogViewerProps {
  lines: LogLine[]
  className?: string
}

const LINE_STYLES: Record<LogLineType, { textClass: string; icon: string; dimmed?: boolean }> = {
  text:           { textClass: 'text-zinc-100', icon: '' },
  tool_use:       { textClass: 'text-cyan-400', icon: '' },
  tool_summary:   { textClass: 'text-zinc-400', icon: '', dimmed: true },
  thinking:       { textClass: 'text-zinc-500', icon: '💭', dimmed: true },
  tool_progress:  { textClass: 'text-zinc-500', icon: '', dimmed: true },
  error:          { textClass: 'text-rose-400', icon: '' },
  result:         { textClass: 'text-emerald-300', icon: '' },
  phase:          { textClass: 'text-indigo-300', icon: '' },
  insight:        { textClass: 'text-violet-300', icon: '' },
  session_reset:  { textClass: 'text-amber-400', icon: '' },
  webhook:        { textClass: 'text-amber-400', icon: '' },
  system:         { textClass: 'text-zinc-600', icon: '', dimmed: true },
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
      <div className="flex items-center gap-2 py-1.5 my-1">
        <div className="h-px flex-1 bg-indigo-800/50" />
        <span className="text-xs font-semibold text-indigo-400 uppercase tracking-wider px-2">
          {content}
        </span>
        <div className="h-px flex-1 bg-indigo-800/50" />
      </div>
    )
  }

  if (line.lineType === 'error') {
    return (
      <div className="bg-rose-950/30 border-l-2 border-rose-500 pl-3 py-1 my-0.5 rounded-r">
        <span className={style.textClass}>{content}</span>
      </div>
    )
  }

  if (line.lineType === 'result') {
    return (
      <div className="bg-emerald-950/20 border-l-2 border-emerald-500 pl-3 py-1 my-0.5 rounded-r">
        <span className={style.textClass}>{content}</span>
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
    <span className={`${style.textClass} ${style.dimmed ? 'opacity-60' : ''}`}>
      {style.icon ? `${style.icon} ` : ''}{content}
    </span>
  )
}

export default function LogViewer({ lines, className = '' }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [filter, setFilter] = useState<'all' | 'main' | 'tools'>('all')

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [lines, autoScroll])

  const handleScroll = () => {
    if (!containerRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current
    const atBottom = scrollHeight - scrollTop - clientHeight < 60
    setAutoScroll(atBottom)
  }

  const TOOL_TYPES: LogLineType[] = ['tool_use', 'tool_summary', 'tool_progress', 'thinking', 'system']
  const MAIN_TYPES: LogLineType[] = ['text', 'phase', 'error', 'result', 'insight', 'session_reset', 'webhook']

  const filteredLines = lines.filter(line => {
    if (filter === 'all') return true
    if (filter === 'main') return MAIN_TYPES.includes(line.lineType)
    if (filter === 'tools') return TOOL_TYPES.includes(line.lineType)
    return true
  })

  return (
    <div className={`flex flex-col bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden ${className}`}>
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 bg-zinc-900 border-b border-zinc-800">
        <div className="flex items-center gap-1">
          {(['all', 'main', 'tools'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                filter === f
                  ? 'bg-zinc-700 text-white'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              {f === 'all' ? 'All' : f === 'main' ? 'Agent' : 'Tools'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-500">
            {filteredLines.length} / {lines.length} lines
          </span>

          {!autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true)
                bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
              }}
              className="px-2 py-1 rounded text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-500 transition-colors"
            >
              ↓ Follow
            </button>
          )}
        </div>
      </div>

      {/* Log content */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-[13px] leading-relaxed p-3 min-h-[200px] max-h-[calc(100vh-280px)]"
      >
        {filteredLines.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-zinc-600 text-sm">
            Waiting for log output...
          </div>
        ) : (
          filteredLines.map((line, i) => (
            <div
              key={i}
              className={`flex gap-3 animate-fade-in ${
                line.lineType === 'phase' ? '' : 'py-[1px] hover:bg-zinc-800/50 rounded px-1 -mx-1'
              }`}
            >
              {line.lineType !== 'phase' && (
                <span className="text-zinc-600 select-none shrink-0 tabular-nums text-xs leading-relaxed pt-[1px]">
                  {formatTimestamp(line.timestamp)}
                </span>
              )}
              <div className="flex-1 min-w-0 break-words whitespace-pre-wrap">
                <LineContent line={line} />
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
