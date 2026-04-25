import { useEffect, useState } from 'react'
import type { ConnectionStatus } from '../types'

interface ConnectionIndicatorProps {
  status: ConnectionStatus
  lastHeartbeat: number
}

const STATUS_CONFIG: Record<ConnectionStatus, { color: string; label: string }> = {
  connecting:    { color: 'bg-amber-400', label: 'Connecting...' },
  connected:     { color: 'bg-emerald-400', label: 'Live' },
  disconnected:  { color: 'bg-zinc-500', label: 'Stream ended' },
  error:         { color: 'bg-rose-400', label: 'Connection lost' },
}

export default function ConnectionIndicator({ status, lastHeartbeat }: ConnectionIndicatorProps) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - lastHeartbeat) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [lastHeartbeat])

  const config = STATUS_CONFIG[status]
  const isLive = status === 'connected' || status === 'connecting'

  return (
    <div className="flex items-center gap-2 text-xs text-zinc-400">
      <span className={`w-2 h-2 rounded-full ${config.color} ${isLive ? 'animate-pulse-dot' : ''}`} />
      <span>{config.label}</span>
      {status === 'connected' && elapsed > 0 && (
        <span className="text-zinc-500">
          · last activity {elapsed}s ago
        </span>
      )}
    </div>
  )
}
