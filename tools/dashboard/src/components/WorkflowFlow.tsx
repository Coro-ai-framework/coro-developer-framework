import type { Artifact, Job, WorkflowPhase } from '../types'

export type PhaseState = 'complete' | 'in-progress' | 'awaiting-input' | 'pending'

interface WorkflowFlowProps {
  job: Job
  phases: WorkflowPhase[]
  selectedPhase: string | null
  onSelectPhase: (phase: string) => void
}

/**
 * Determine the visual state of a phase node given the live job state.
 * A phase is:
 *   - `complete` if it appears before the current phase or has a phaseUsage entry
 *   - `awaiting-input` if it matches job.phase and status = awaiting-developer-input
 *   - `in-progress` if it matches job.phase and the job is not parked/terminal
 *   - `pending` otherwise
 */
export function computePhaseState(
  phaseName: string,
  phases: WorkflowPhase[],
  job: Job,
): PhaseState {
  const currentIdx = phases.findIndex(p => p.name === job.phase)
  const thisIdx = phases.findIndex(p => p.name === phaseName)
  const hasUsage = (job.phaseUsage ?? []).some(p => p.phase === phaseName)

  if (thisIdx === -1) return 'pending'

  if (thisIdx === currentIdx) {
    if (job.status === 'awaiting-developer-input') return 'awaiting-input'
    if (job.status === 'complete') return 'complete'
    return 'in-progress'
  }

  if (currentIdx !== -1 && thisIdx < currentIdx) return 'complete'
  if (hasUsage) return 'complete'
  if (job.status === 'complete') return 'complete'

  return 'pending'
}

function phaseStateClasses(state: PhaseState, selected: boolean): string {
  const base = 'relative flex-1 min-w-[140px] rounded-lg border px-3 py-2.5 text-left transition-all cursor-pointer'
  const ring = selected ? 'ring-2 ring-indigo-500 ring-offset-2 ring-offset-zinc-950' : ''
  switch (state) {
    case 'complete':
      return `${base} ${ring} bg-emerald-950/30 border-emerald-800/60 hover:border-emerald-700`
    case 'in-progress':
      return `${base} ${ring} bg-indigo-950/30 border-indigo-700 hover:border-indigo-500 shadow-[0_0_0_1px_rgb(99_102_241/0.3)]`
    case 'awaiting-input':
      return `${base} ${ring} bg-amber-950/30 border-amber-700 hover:border-amber-500 animate-pulse-slow`
    case 'pending':
    default:
      return `${base} ${ring} bg-zinc-900/40 border-zinc-800 hover:border-zinc-700`
  }
}

function stateIcon(state: PhaseState): JSX.Element {
  switch (state) {
    case 'complete':
      return (
        <svg className="w-3.5 h-3.5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      )
    case 'in-progress':
      return (
        <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse-dot" />
      )
    case 'awaiting-input':
      return (
        <svg className="w-3.5 h-3.5 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      )
    default:
      return (
        <span className="w-2 h-2 rounded-full bg-zinc-600" />
      )
  }
}

function stateLabel(state: PhaseState): string {
  switch (state) {
    case 'complete':       return 'Complete'
    case 'in-progress':    return 'Running'
    case 'awaiting-input': return 'Awaiting input'
    case 'pending':        return 'Pending'
  }
}

export default function WorkflowFlow({ job, phases, selectedPhase, onSelectPhase }: WorkflowFlowProps) {
  if (phases.length === 0) {
    return (
      <div className="text-xs text-zinc-500 italic px-2 py-3">No workflow phases defined for this job.</div>
    )
  }

  const artifactsByPhase = new Map<string, Artifact[]>()
  for (const a of job.artifacts ?? []) {
    const bucket = artifactsByPhase.get(a.phase) ?? []
    bucket.push(a)
    artifactsByPhase.set(a.phase, bucket)
  }

  return (
    <div className="w-full overflow-x-auto">
      <div className="flex items-stretch gap-2 min-w-max pb-1">
        {phases.map((phase, i) => {
          const state = computePhaseState(phase.name, phases, job)
          const selected = selectedPhase === phase.name
          const artifacts = artifactsByPhase.get(phase.name) ?? []

          return (
            <div key={phase.name} className="flex items-stretch">
              <button
                type="button"
                onClick={() => onSelectPhase(phase.name)}
                className={phaseStateClasses(state, selected)}
              >
                <div className="flex items-center gap-2">
                  {stateIcon(state)}
                  <span className="text-sm font-medium text-zinc-100 truncate">{phase.name}</span>
                  {phase.interactiveCheckpoint && job.interactive && (
                    <span
                      title="Interactive checkpoint — the job will park here for developer approval"
                      className="text-[10px] px-1 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-800"
                    >
                      ✋
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{stateLabel(state)}</span>
                  {artifacts.length > 0 && (
                    <span className="text-[10px] text-indigo-300 bg-indigo-950/50 border border-indigo-800/60 px-1.5 py-0.5 rounded-full">
                      {artifacts.length} artefact{artifacts.length === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
              </button>

              {i < phases.length - 1 && (
                <div className="flex items-center px-1 text-zinc-700 shrink-0" aria-hidden>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
