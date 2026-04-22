import { useEffect, useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useJob } from '../hooks/useJob'
import { useJobStream } from '../hooks/useJobStream'
import LogViewer from '../components/LogViewer'
import ConnectionIndicator from '../components/ConnectionIndicator'
import StatusBadge from '../components/StatusBadge'
import WorkflowFlow, { computePhaseState } from '../components/WorkflowFlow'
import ArtifactLink from '../components/ArtifactLink'
import ApprovalBox from '../components/ApprovalBox'
import type { TokenUsage, PhaseUsage, WorkflowPhase } from '../types'

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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function formatDuration(ms: number): string {
  if (ms === 0) return '—'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

function TokenUsageCard({ usage }: { usage: TokenUsage }) {
  const totalTokens = usage.inputTokens + usage.outputTokens
  const cacheHitRate = usage.inputTokens > 0
    ? ((usage.cacheReadInputTokens / (usage.inputTokens + usage.cacheCreationInputTokens)) * 100)
    : 0

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">Token Usage</h3>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div>
          <div className="text-xs text-zinc-500">Total Tokens</div>
          <div className="text-lg font-semibold text-zinc-100">{formatTokens(totalTokens)}</div>
        </div>
        <div>
          <div className="text-xs text-zinc-500">Input / Output</div>
          <div className="text-sm font-medium text-zinc-200">
            {formatTokens(usage.inputTokens)} <span className="text-zinc-600">/</span> {formatTokens(usage.outputTokens)}
          </div>
        </div>
        <div>
          <div className="text-xs text-zinc-500">Cache Read / Write</div>
          <div className="text-sm font-medium text-zinc-200">
            {formatTokens(usage.cacheReadInputTokens)} <span className="text-zinc-600">/</span> {formatTokens(usage.cacheCreationInputTokens)}
          </div>
        </div>
        <div>
          <div className="text-xs text-zinc-500">Cache Hit Rate</div>
          <div className="text-sm font-medium text-zinc-200">
            {cacheHitRate > 0 ? `${cacheHitRate.toFixed(0)}%` : '—'}
          </div>
        </div>
      </div>
    </div>
  )
}

function PhaseUsageTable({ phases }: { phases: PhaseUsage[] }) {
  if (phases.length === 0) return null

  return (
    <div className="rounded-lg border border-zinc-800 overflow-hidden">
      <div className="px-3 py-2 bg-zinc-900">
        <span className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Usage by Phase</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-zinc-800 text-zinc-500">
              <th className="text-left px-3 py-2 font-medium">Phase</th>
              <th className="text-right px-3 py-2 font-medium">Input</th>
              <th className="text-right px-3 py-2 font-medium">Output</th>
              <th className="text-right px-3 py-2 font-medium">Cache Read</th>
              <th className="text-right px-3 py-2 font-medium">Duration</th>
              <th className="text-right px-3 py-2 font-medium">Turns</th>
              <th className="text-left px-3 py-2 font-medium">Model</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/50">
            {phases.map((p, i) => (
              <tr key={`${p.phase}-${i}`} className="text-zinc-300 hover:bg-zinc-800/30 transition-colors">
                <td className="px-3 py-2 font-medium text-zinc-200">{p.phase}</td>
                <td className="text-right px-3 py-2 tabular-nums">{formatTokens(p.inputTokens)}</td>
                <td className="text-right px-3 py-2 tabular-nums">{formatTokens(p.outputTokens)}</td>
                <td className="text-right px-3 py-2 tabular-nums">{formatTokens(p.cacheReadInputTokens)}</td>
                <td className="text-right px-3 py-2 tabular-nums">{formatDuration(p.durationMs)}</td>
                <td className="text-right px-3 py-2 tabular-nums">{p.numTurns}</td>
                <td className="px-3 py-2 text-zinc-400 truncate max-w-[140px]">{p.model}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const RESUMABLE_STATUSES = new Set([
  'failed', 'escalated', 'awaiting-plan-approval', 'awaiting-pr-merge', 'queued',
  // Phase statuses — job may be stuck here after a server restart or crash
  'planning', 'coding', 'reviewing', 'testing', 'evaluating',
  'spec-writing', 'analysis', 'repo-setup', 'reporting',
])

const NON_RUNNING_STATUSES = new Set([
  'complete', 'failed', 'escalated', 'awaiting-plan-approval', 'awaiting-pr-merge', 'queued',
])

export default function JobDetail() {
  const { jobId } = useParams<{ jobId: string }>()
  const { job, loading, error, refetch } = useJob(jobId)
  const { lines, status: connStatus, lastHeartbeat } = useJobStream(jobId)
  const [resuming, setResuming] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const [showResumeOptions, setShowResumeOptions] = useState(false)
  const [resumePhase, setResumePhase] = useState<string>('')
  const [clearSession, setClearSession] = useState(false)
  const [messageText, setMessageText] = useState('')
  const [sendingMessage, setSendingMessage] = useState(false)
  const [messageError, setMessageError] = useState<string | null>(null)
  const [selectedPhase, setSelectedPhase] = useState<string | null>(null)

  // When the job's live phase changes (auto-advance, resume, etc.), follow it
  // in the flowchart so the selected panel reflects the current work.
  useEffect(() => {
    if (!job) return
    setSelectedPhase(prev => (prev === null ? job.phase : prev))
  }, [job])

  // Auto-refresh the job object periodically so artefact posts and status
  // transitions show up without a manual reload. Cheap — single GET.
  useEffect(() => {
    if (!job) return
    if (NON_RUNNING_STATUSES.has(job.status) && job.status !== 'awaiting-developer-input') return
    const interval = setInterval(() => { void refetch() }, 4000)
    return () => clearInterval(interval)
  }, [job, refetch])

  const workflowPhases: WorkflowPhase[] = useMemo(() => {
    if (job?.workflowPhases && job.workflowPhases.length > 0) return job.workflowPhases
    // Fallback: derive from the phaseUsage timeline + current phase.
    if (!job) return []
    const seen: WorkflowPhase[] = []
    const names = new Set<string>()
    for (const p of job.phaseUsage ?? []) {
      if (!names.has(p.phase)) { names.add(p.phase); seen.push({ name: p.phase, status: p.phase }) }
    }
    if (!names.has(job.phase)) {
      seen.push({ name: job.phase, status: job.phase })
    }
    return seen
  }, [job])

  const handleResume = async (fromPhase?: string, shouldClearSession = false) => {
    if (!jobId) return
    setResuming(true)
    setResumeError(null)
    try {
      const body: Record<string, unknown> = {}
      if (fromPhase) body.fromPhase = fromPhase
      if (shouldClearSession) body.clearSession = true

      const res = await fetch(`/jobs/${jobId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      setShowResumeOptions(false)
      await refetch()
    } catch (err) {
      setResumeError(err instanceof Error ? err.message : 'Resume failed')
    } finally {
      setResuming(false)
    }
  }

  const postMessage = async (text: string): Promise<void> => {
    if (!jobId) throw new Error('No job ID')
    const res = await fetch(`/jobs/${jobId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    })
    if (!res.ok) {
      const data = await res.json() as { error?: string }
      throw new Error(data.error ?? `HTTP ${res.status}`)
    }
    await refetch()
  }

  const handleSendMessage = async () => {
    if (!jobId || !messageText.trim()) return
    setSendingMessage(true)
    setMessageError(null)
    try {
      await postMessage(messageText.trim())
      setMessageText('')
    } catch (err) {
      setMessageError(err instanceof Error ? err.message : 'Failed to send')
    } finally {
      setSendingMessage(false)
    }
  }

  const canSendMessage = job && !NON_RUNNING_STATUSES.has(job.status)

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

  const currentPhaseName = selectedPhase ?? job.phase
  const phaseArtifacts = (job.artifacts ?? []).filter(a => a.phase === currentPhaseName)
  const phaseUsageForSelected = (job.phaseUsage ?? []).find(p => p.phase === currentPhaseName)
  const phaseState = workflowPhases.length > 0
    ? computePhaseState(currentPhaseName, workflowPhases, job)
    : 'pending'

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      {/* Breadcrumb + header */}
      <div className="mb-5">
        <Link to="/" className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
          ← Back
        </Link>

        <div className="flex items-start justify-between mt-2">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-lg font-semibold text-white">
                {job.params['serviceName'] as string ?? job.id}
              </h1>
              <StatusBadge status={job.status} />
              {job.interactive && (
                <span
                  title="This job pauses between phases for developer approval"
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-950/40 text-amber-300 border border-amber-800"
                >
                  ✋ Interactive
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-500 mt-1 font-mono">{job.id}</p>
          </div>

          <div className="flex items-center gap-2">
            {RESUMABLE_STATUSES.has(job.status) && (
              <div className="relative">
                <div className="flex">
                  <button
                    onClick={() => void handleResume()}
                    disabled={resuming}
                    className="px-3 py-1.5 rounded-l-md text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {resuming ? 'Resuming...' : `▶ Resume (${job.phase})`}
                  </button>
                  <button
                    onClick={() => setShowResumeOptions(prev => !prev)}
                    disabled={resuming}
                    className="px-1.5 py-1.5 rounded-r-md text-xs font-medium bg-indigo-700 text-white hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors border-l border-indigo-500"
                    title="Resume options"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </div>

                {showResumeOptions && (
                  <div className="absolute right-0 top-full mt-1 w-72 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl z-20 p-3 space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-zinc-400 mb-1">Resume from phase</label>
                      <select
                        value={resumePhase}
                        onChange={(e) => setResumePhase(e.target.value)}
                        className="w-full px-2.5 py-1.5 rounded-md bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
                      >
                        <option value="">Current phase ({job.phase})</option>
                        {workflowPhases.map(p => (
                          <option key={p.name} value={p.name}>{p.name}{p.name === job.phase ? ' (current)' : ''}</option>
                        ))}
                      </select>
                    </div>

                    <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={clearSession}
                        onChange={(e) => setClearSession(e.target.checked)}
                        className="rounded bg-zinc-800 border-zinc-600 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0"
                      />
                      Fresh session (discard conversation history)
                    </label>

                    <div className="flex items-center justify-between pt-1 border-t border-zinc-800">
                      <button
                        onClick={() => setShowResumeOptions(false)}
                        className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => void handleResume(resumePhase || undefined, clearSession)}
                        disabled={resuming}
                        className="px-3 py-1.5 rounded-md text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                      >
                        {resuming ? 'Resuming...' : 'Resume'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
            <button
              onClick={() => void refetch()}
              className="px-3 py-1.5 rounded-md text-xs font-medium text-zinc-400 bg-zinc-800 hover:bg-zinc-700 hover:text-zinc-200 transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Resume error */}
      {resumeError && (
        <div className="mb-4 p-3 rounded-lg bg-rose-950/30 border border-rose-800 text-rose-300 text-sm flex items-center justify-between">
          <span>Resume failed: {resumeError}</span>
          <button onClick={() => setResumeError(null)} className="text-rose-400 hover:text-rose-200 text-xs">dismiss</button>
        </div>
      )}

      {/* Workflow flowchart */}
      <div className="bg-zinc-900/40 border border-zinc-800 rounded-lg p-3 mb-5">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Workflow</h3>
          <span className="text-xs text-zinc-500">Tap a phase to see its artefacts and logs</span>
        </div>
        <WorkflowFlow
          job={job}
          phases={workflowPhases}
          selectedPhase={selectedPhase}
          onSelectPhase={setSelectedPhase}
        />
      </div>

      {/* Approval + rework UI — only when parked waiting for developer */}
      {job.status === 'awaiting-developer-input' && (
        <div className="mb-5">
          <ApprovalBox job={job} onSend={postMessage} />
        </div>
      )}

      {/* Selected phase panel */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-xs text-zinc-500 uppercase tracking-wider">Phase</div>
            <div className="text-base font-semibold text-zinc-100">{currentPhaseName}</div>
          </div>
          <div className="text-right">
            <div className="text-xs text-zinc-500 uppercase tracking-wider">State</div>
            <div className="text-sm font-medium text-zinc-200 capitalize">{phaseState.replace('-', ' ')}</div>
          </div>
        </div>

        <div>
          <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-2">
            Artefacts{phaseArtifacts.length > 0 && ` (${phaseArtifacts.length})`}
          </h4>
          {phaseArtifacts.length === 0 ? (
            <p className="text-xs text-zinc-500 italic">
              No artefacts posted for this phase yet.
            </p>
          ) : (
            <div className="space-y-2">
              {phaseArtifacts.map(a => (
                <ArtifactLink key={a.id} jobId={job.id} artifact={a} />
              ))}
            </div>
          )}
        </div>

        {phaseUsageForSelected && (
          <div className="mt-4 pt-3 border-t border-zinc-800 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <div className="text-xs text-zinc-500">Input</div>
              <div className="text-sm text-zinc-200 tabular-nums">{formatTokens(phaseUsageForSelected.inputTokens)}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Output</div>
              <div className="text-sm text-zinc-200 tabular-nums">{formatTokens(phaseUsageForSelected.outputTokens)}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Duration</div>
              <div className="text-sm text-zinc-200 tabular-nums">{formatDuration(phaseUsageForSelected.durationMs)}</div>
            </div>
            <div>
              <div className="text-xs text-zinc-500">Turns</div>
              <div className="text-sm text-zinc-200 tabular-nums">{phaseUsageForSelected.numTurns}</div>
            </div>
          </div>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
          <div className="text-xs text-zinc-500 mb-0.5">Type</div>
          <div className="text-sm font-medium text-zinc-200 capitalize">{job.type}</div>
        </div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
          <div className="text-xs text-zinc-500 mb-0.5">Current phase</div>
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

      {/* Awaiting event — show non-interactive waits here; interactive is handled by ApprovalBox above */}
      {job.awaitingEvent && job.status !== 'awaiting-developer-input' && (
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

      {/* Free-form message to a running agent (not parked) */}
      {canSendMessage && job.status !== 'awaiting-developer-input' && (
        <div className="mb-5">
          {messageError && (
            <div className="mb-2 p-2 rounded-lg bg-rose-950/30 border border-rose-800 text-rose-300 text-xs flex items-center justify-between">
              <span>{messageError}</span>
              <button onClick={() => setMessageError(null)} className="text-rose-400 hover:text-rose-200 text-xs ml-2">dismiss</button>
            </div>
          )}
          <form
            onSubmit={(e) => { e.preventDefault(); void handleSendMessage() }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              placeholder="Send a message to the agent..."
              disabled={sendingMessage}
              className="flex-1 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 disabled:opacity-50 transition-colors"
            />
            <button
              type="submit"
              disabled={sendingMessage || !messageText.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
            >
              {sendingMessage ? 'Sending...' : 'Send'}
            </button>
          </form>
        </div>
      )}

      {/* Token usage — collapsed by default at the bottom */}
      {job.tokenUsage && (job.tokenUsage.inputTokens > 0 || job.tokenUsage.outputTokens > 0) && (
        <div className="mb-5">
          <TokenUsageCard usage={job.tokenUsage} />
        </div>
      )}

      {/* Phase usage breakdown */}
      {job.phaseUsage && job.phaseUsage.length > 0 && (
        <div className="mb-5">
          <PhaseUsageTable phases={job.phaseUsage} />
        </div>
      )}

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
