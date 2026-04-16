import { Link } from 'react-router-dom'
import { useJobs } from '../hooks/useJobs'
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

const TYPE_STYLES: Record<string, string> = {
  migration: 'bg-violet-950 text-violet-300',
  feature: 'bg-cyan-950 text-cyan-300',
  'self-update': 'bg-zinc-800 text-zinc-300',
}

export default function JobList() {
  const { jobs, loading, error } = useJobs()

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-white">Jobs</h1>
          <p className="text-sm text-zinc-400 mt-0.5">
            {jobs.length} job{jobs.length !== 1 ? 's' : ''} tracked
          </p>
        </div>
        <Link
          to="/jobs/new"
          className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 transition-colors"
        >
          + New Job
        </Link>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-rose-950/30 border border-rose-800 text-rose-300 text-sm">
          Failed to load jobs: {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-20 rounded-lg bg-zinc-900 border border-zinc-800 animate-pulse" />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-16 text-zinc-500">
          <p className="text-lg">No jobs yet</p>
          <p className="text-sm mt-1">Jobs will appear here when dispatched via the CLI or webhooks.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {jobs.map(job => (
            <Link
              key={job.id}
              to={`/jobs/${job.id}`}
              className="block rounded-lg bg-zinc-900 border border-zinc-800 p-4 hover:border-zinc-700 hover:bg-zinc-900/80 transition-all group"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5 mb-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${TYPE_STYLES[job.type] ?? TYPE_STYLES['self-update']}`}>
                      {job.type}
                    </span>
                    <h3 className="text-sm font-medium text-zinc-200 truncate group-hover:text-white transition-colors">
                      {job.serviceName ?? job.id}
                    </h3>
                  </div>

                  <div className="flex items-center gap-3 text-xs text-zinc-500">
                    <span title={job.id} className="truncate max-w-[280px]">{job.id}</span>
                    <span>·</span>
                    <span>phase: {job.phase}</span>
                    {job.currentFeature && (
                      <>
                        <span>·</span>
                        <span className="text-zinc-400">{job.currentFeature}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <StatusBadge status={job.status} />
                  <div className="flex items-center gap-2 text-xs text-zinc-500">
                    {typeof job.totalCostUsd === 'number' && job.totalCostUsd > 0 && (
                      <span className="text-emerald-500">${job.totalCostUsd < 0.01 ? job.totalCostUsd.toFixed(4) : job.totalCostUsd.toFixed(2)}</span>
                    )}
                    {job.prCount > 0 && (
                      <span>{job.prCount} PR{job.prCount !== 1 ? 's' : ''}</span>
                    )}
                    <span title={job.updatedAt}>{timeAgo(job.updatedAt)}</span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
