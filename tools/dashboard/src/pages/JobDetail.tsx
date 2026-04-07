import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useJob } from '../hooks/useJob'
import { useJobStream } from '../hooks/useJobStream'
import LogViewer from '../components/LogViewer'
import ConnectionIndicator from '../components/ConnectionIndicator'
import StatusBadge from '../components/StatusBadge'

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function FeatureProgress({ features }: { features: { name: string; status: string; loopCount: number }[] }) {
  if (features.length === 0) return null

  const statusColor: Record<string, string> = {
    'pending': 'bg-zinc-700',
    'in-progress': 'bg-indigo-500',
    'complete': 'bg-emerald-500',
    'escalated': 'bg-rose-500',
  }

  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Features</h4>
      <div className="space-y-1">
        {features.map(f => (
          <div key={f.name} className="flex items-center gap-2 text-xs">
            <span className={`w-2 h-2 rounded-full shrink-0 ${statusColor[f.status] ?? 'bg-zinc-600'}`} />
            <span className="text-zinc-300 flex-1 truncate">{f.name}</span>
            <span className="text-zinc-500">{f.status}</span>
            {f.loopCount > 1 && <span className="text-zinc-600">×{f.loopCount}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

function CollapsibleJson({ label, data, defaultOpen = false }: { label: string; data: unknown; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className="rounded-lg border border-zinc-800 overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 bg-zinc-900 hover:bg-zinc-800/80 transition-colors text-left"
      >
        <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">{label}</span>
        <svg
          className={`w-4 h-4 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <pre className="p-3 text-xs font-mono text-zinc-300 bg-zinc-950 overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap break-words">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  )
}

export default function JobDetail() {
  const { jobId } = useParams<{ jobId: string }>()
  const { job, loading, error, refetch } = useJob(jobId)
  const { lines, status: connStatus, lastHeartbeat } = useJobStream(jobId)

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 bg-zinc-800 rounded" />
          <div className="h-64 bg-zinc-900 rounded-lg border border-zinc-800" />
        </div>
      </div>
    )
  }

  if (error || !job) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="p-6 rounded-lg bg-rose-950/30 border border-rose-800 text-center">
          <p className="text-rose-300 mb-2">{error ?? 'Job not found'}</p>
          <Link to="/" className="text-sm text-indigo-400 hover:text-indigo-300">
            ← Enter another job ID
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      {/* Breadcrumb + header */}
      <div className="mb-5">
        <Link to="/" className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
          ← Back
        </Link>

        <div className="flex items-start justify-between mt-2">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold text-white">
                {job.params['serviceName'] as string ?? job.id}
              </h1>
              <StatusBadge status={job.status} />
            </div>
            <p className="text-xs text-zinc-500 mt-1 font-mono">{job.id}</p>
          </div>

          <button
            onClick={() => void refetch()}
            className="px-3 py-1.5 rounded-md text-xs font-medium text-zinc-400 bg-zinc-800 hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
          <div className="text-xs text-zinc-500 mb-0.5">Type</div>
          <div className="text-sm font-medium text-zinc-200 capitalize">{job.type}</div>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
          <div className="text-xs text-zinc-500 mb-0.5">Phase</div>
          <div className="text-sm font-medium text-zinc-200">{job.phase}</div>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
          <div className="text-xs text-zinc-500 mb-0.5">Created</div>
          <div className="text-sm font-medium text-zinc-200">{timeAgo(job.createdAt)}</div>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
          <div className="text-xs text-zinc-500 mb-0.5">Updated</div>
          <div className="text-sm font-medium text-zinc-200">{timeAgo(job.updatedAt)}</div>
        </div>
      </div>

      {/* Features */}
      {job.features?.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3 mb-5">
          <FeatureProgress features={job.features} />
        </div>
      )}

      {/* Escalation message */}
      {job.escalationMessage && (
        <div className="mb-5 p-3 rounded-lg bg-rose-950/30 border border-rose-800">
          <div className="text-xs text-rose-400 font-medium mb-1">Escalation</div>
          <p className="text-sm text-rose-200 whitespace-pre-wrap">{job.escalationMessage}</p>
        </div>
      )}

      {/* Awaiting event */}
      {job.awaitingEvent && (
        <div className="mb-5 p-3 rounded-lg bg-amber-950/30 border border-amber-800">
          <div className="text-xs text-amber-400 font-medium mb-1">Awaiting Event</div>
          <p className="text-sm text-amber-200">{job.awaitingEvent}</p>
          {job.awaitingPrId && <p className="text-xs text-amber-300 mt-1">PR #{job.awaitingPrId}</p>}
        </div>
      )}

      {/* Log stream */}
      <div className="mb-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-zinc-300">Live Logs</h2>
          <ConnectionIndicator status={connStatus} lastHeartbeat={lastHeartbeat} />
        </div>
        <LogViewer lines={lines} />
      </div>

      {/* Collapsible sections */}
      <div className="space-y-3">
        <CollapsibleJson label="Job Parameters" data={job.params} />
        <CollapsibleJson label="Full Job Object" data={job} />
        {job.insights?.length > 0 && (
          <CollapsibleJson label={`Insights (${job.insights.length})`} data={job.insights} />
        )}
        {job.prMappings?.length > 0 && (
          <CollapsibleJson label={`PR Mappings (${job.prMappings.length})`} data={job.prMappings} />
        )}
      </div>
    </div>
  )
}
