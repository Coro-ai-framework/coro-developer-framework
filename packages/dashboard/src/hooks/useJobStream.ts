import { useState, useEffect, useRef, useCallback } from 'react'
import type { ConnectionStatus } from '../types'

export interface LogLine {
  timestamp: string
  content: string
  lineType: LogLineType
}

export type LogLineType =
  | 'text'
  | 'tool_use'
  | 'tool_summary'
  | 'thinking'
  | 'tool_progress'
  | 'error'
  | 'result'
  | 'phase'
  | 'insight'
  | 'session_reset'
  | 'webhook'
  | 'human'
  | 'system'

const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+/

export function classifyLine(raw: string): { content: string; lineType: LogLineType } {
  const content = raw.replace(TIMESTAMP_RE, '')

  if (content.startsWith('→ '))            return { content, lineType: 'tool_use' }
  if (content.startsWith('[thinking]'))     return { content, lineType: 'thinking' }
  if (content.startsWith('[tool_summary]')) return { content, lineType: 'tool_summary' }
  if (content.startsWith('⏳'))             return { content, lineType: 'tool_progress' }
  if (content.startsWith('[error]'))        return { content, lineType: 'error' }
  if (content.startsWith('[result]'))       return { content, lineType: 'result' }
  if (content.startsWith('[insight]'))      return { content, lineType: 'insight' }
  if (content.startsWith('[session-reset]'))return { content, lineType: 'session_reset' }
  if (content.startsWith('[webhook]'))      return { content, lineType: 'webhook' }
  if (content.startsWith('[human]'))        return { content, lineType: 'human' }
  if (content.startsWith('[event:'))        return { content, lineType: 'system' }
  if (content.startsWith('Phase advanced')) return { content, lineType: 'phase' }
  if (content.startsWith('Runner started')) return { content, lineType: 'phase' }
  if (content.startsWith('Job parked'))     return { content, lineType: 'phase' }
  if (content.startsWith('All phases complete')) return { content, lineType: 'phase' }
  if (content.startsWith('Runner crashed')) return { content, lineType: 'error' }

  return { content, lineType: 'text' }
}

function parseTimestamp(raw: string): string {
  const match = raw.match(TIMESTAMP_RE)
  return match ? match[1] : ''
}

export function useJobStream(jobId: string | undefined) {
  const [lines, setLines] = useState<LogLine[]>([])
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [lastHeartbeat, setLastHeartbeat] = useState<number>(Date.now())
  const eventSourceRef = useRef<EventSource | null>(null)
  const streamEndedRef = useRef(false)

  const disconnect = useCallback(() => {
    streamEndedRef.current = true
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!jobId) return

    setLines([])
    setStatus('connecting')
    streamEndedRef.current = false

    const source = new EventSource(`/jobs/${jobId}/stream`)
    eventSourceRef.current = source

    source.onopen = () => {
      setStatus('connected')
      setLastHeartbeat(Date.now())
    }

    source.onmessage = (event: MessageEvent) => {
      setLastHeartbeat(Date.now())
      const raw = event.data as string

      if (!raw || raw.trim() === '') return

      const timestamp = parseTimestamp(raw)
      const { content, lineType } = classifyLine(raw)

      setLines(prev => [...prev, { timestamp, content, lineType }])
    }

    source.onerror = () => {
      // EventSource auto-reconnects on error. When the server closes
      // the stream (job completed), readyState transitions to CLOSED.
      // We must close explicitly to prevent the browser from reconnecting
      // and replaying all log lines in a loop.
      source.close()
      eventSourceRef.current = null
      streamEndedRef.current = true
      setStatus('disconnected')
    }

    return () => {
      source.close()
      eventSourceRef.current = null
    }
  }, [jobId])

  return { lines, status, lastHeartbeat, disconnect }
}
