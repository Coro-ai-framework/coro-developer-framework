import { useEffect, useState } from 'react'
import { formatRelativeTime } from '../lib/format'
import { getConnectionMeta, toneClasses, toneDotClasses } from '../lib/status'
import type { ConnectionStatus } from '../types'

interface ConnectionIndicatorProps {
  status: ConnectionStatus
  lastHeartbeat: number
}

export default function ConnectionIndicator({ status, lastHeartbeat }: ConnectionIndicatorProps) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - lastHeartbeat) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [lastHeartbeat])

  const meta = getConnectionMeta(status)

  return (
    <div className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] ${toneClasses(meta.tone)}`}>
      <span className={`size-1.5 rounded-full ${toneDotClasses(meta.tone)} ${meta.pulse ? 'animate-pulse-dot' : ''}`} />
      <span className="font-medium uppercase tracking-[0.16em]">{meta.label}</span>
      {status === 'connected' && elapsed > 0 ? (
        <span className="text-fg-muted normal-case tracking-normal">
          · {formatRelativeTime(new Date(Date.now() - elapsed * 1000))}
        </span>
      ) : null}
    </div>
  )
}
