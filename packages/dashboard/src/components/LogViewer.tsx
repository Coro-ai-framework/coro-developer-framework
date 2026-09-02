import { useState } from 'react'
import {
  ArrowDownToLine,
  ArrowRight,
  Bot,
  CheckCircle2,
  GitBranch,
  Layers3,
  Loader2,
  MessageSquareReply,
  RefreshCcw,
  Search,
  Settings2,
  ShieldAlert,
  TriangleAlert,
  Waypoints,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { LogLine, LogLineType } from '../hooks/useJobStream'
import { useStickToBottom } from './activity/use-stick-to-bottom'
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
const LINE_STYLES: Record<LogLineType, {
  textClass: string
  iconClass: string
  icon: LucideIcon
  label?: string
  dimmed?: boolean
}> = {
  text:           { textClass: 'text-fg', iconClass: 'text-fg-subtle', icon: Bot },
  tool_use:       { textClass: 'text-fg', iconClass: 'text-accent-300', icon: ArrowRight, label: 'Tool' },
  tool_summary:   { textClass: 'text-fg-muted', iconClass: 'text-fg-subtle', icon: Layers3, label: 'Summary', dimmed: true },
  thinking:       { textClass: 'text-fg-muted', iconClass: 'text-fg-subtle', icon: Search, label: 'Thinking', dimmed: true },
  tool_progress:  { textClass: 'text-fg-muted', iconClass: 'text-warning-400', icon: Loader2, label: 'Progress', dimmed: true },
  error:          { textClass: 'text-danger-400', iconClass: 'text-danger-400', icon: TriangleAlert, label: 'Error' },
  guardrail:      { textClass: 'text-warning-400', iconClass: 'text-warning-400', icon: ShieldAlert, label: 'Guardrail' },
  warning:        { textClass: 'text-warning-400', iconClass: 'text-warning-400', icon: TriangleAlert, label: 'Warning' },
  result:         { textClass: 'text-success-400', iconClass: 'text-success-400', icon: CheckCircle2, label: 'Result' },
  phase:          { textClass: 'text-accent-300', iconClass: 'text-accent-300', icon: GitBranch, label: 'Phase' },
  insight:        { textClass: 'text-accent-300', iconClass: 'text-accent-300', icon: Bot, label: 'Insight' },
  session_reset:  { textClass: 'text-warning-400', iconClass: 'text-warning-400', icon: RefreshCcw, label: 'Reset' },
  webhook:        { textClass: 'text-warning-400', iconClass: 'text-warning-400', icon: Waypoints, label: 'Webhook' },
  human:          { textClass: 'text-fg', iconClass: 'text-accent-300', icon: MessageSquareReply, label: 'Developer' },
  system:         { textClass: 'text-fg-subtle', iconClass: 'text-fg-subtle', icon: Settings2, label: 'System', dimmed: true },
}

function displayContent(line: LogLine): string {
  const content = line.content

  if (line.lineType === 'tool_progress') {
    return content.replace(/^⏳\s*/, '')
  }

  if (line.lineType === 'system' && content.startsWith('[event:')) {
    return content.replace(/^\[event:([^\]]+)\]\s*/, '$1: ')
  }

  if (line.lineType === 'tool_use' || line.lineType === 'text' || line.lineType === 'phase') {
    return content
  }

  return content.replace(/^\[[^\]]+\]\s*/, '')
}

function LineIcon({ lineType, className = '' }: { lineType: LogLineType; className?: string }) {
  const style = LINE_STYLES[lineType]
  const Icon = style.icon

  return (
    <Icon
      className={cn(
        'mt-0.5 size-3.5 shrink-0',
        style.iconClass,
        style.dimmed && 'opacity-60',
        lineType === 'tool_progress' && 'animate-spin',
        className,
      )}
      aria-hidden="true"
    />
  )
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
  const content = displayContent(line)

  if (line.lineType === 'phase') {
    return (
      <div className="my-2 flex items-center gap-3 py-1.5">
        <div className="h-px flex-1 bg-accent-500/20" />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-accent-500/25 bg-accent-500/10 px-3 py-0.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-accent-300">
          <LineIcon lineType={line.lineType} className="mt-0 size-3" />
          {content}
        </span>
        <div className="h-px flex-1 bg-accent-500/20" />
      </div>
    )
  }

  if (line.lineType === 'error' || line.lineType === 'warning' || line.lineType === 'guardrail') {
    return (
      <div className={cn(
        'my-1 flex items-start gap-3 rounded-xl px-4 py-2.5',
        line.lineType === 'error'
          ? 'border border-danger-500/25 bg-danger-500/8'
          : 'border border-warning-500/25 bg-warning-500/8',
      )}>
        <LineIcon lineType={line.lineType} />
        <span className={style.textClass}>{content}</span>
      </div>
    )
  }

  if (line.lineType === 'result') {
    return (
      <div className="my-1 flex items-start gap-3 rounded-xl border border-success-500/25 bg-success-500/8 px-4 py-2.5">
        <LineIcon lineType={line.lineType} />
        <span className={style.textClass}>{content}</span>
      </div>
    )
  }

  if (line.lineType === 'human') {
    return (
      <div className="my-1 flex items-start gap-3 rounded-xl border border-accent-500/25 bg-accent-500/8 px-4 py-2.5">
        <LineIcon lineType={line.lineType} />
        <div>
          <span className="mr-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-300">Developer</span>
          <span className="text-fg">{content}</span>
        </div>
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
      <LineIcon lineType={line.lineType} />
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

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'main', label: 'Agent' },
  { value: 'tools', label: 'Tools' },
] as const

type LogFilter = (typeof FILTER_OPTIONS)[number]['value']

export default function LogViewer({ lines, className = '' }: LogViewerProps) {
  const [filter, setFilter] = useState<LogFilter>('all')
  const stick = useStickToBottom<HTMLDivElement>([lines, filter])

  const TOOL_TYPES: LogLineType[] = ['tool_use', 'tool_summary', 'tool_progress', 'thinking', 'system']
  const MAIN_TYPES: LogLineType[] = [
    'text', 'phase', 'error', 'guardrail', 'warning', 'result', 'insight', 'session_reset', 'webhook', 'human',
  ]

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

          {!stick.stuck ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={stick.scrollToBottom}
            >
              <ArrowDownToLine />
              Follow
            </Button>
          ) : null}
        </div>
      </div>

      <div
        ref={stick.ref}
        onScroll={stick.onScroll}
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
