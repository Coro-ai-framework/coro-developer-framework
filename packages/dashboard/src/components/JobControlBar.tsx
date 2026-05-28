import { useEffect, useState } from 'react'
import { Ban, ChevronDown, Loader2, Pause, RefreshCcw, Play } from 'lucide-react'
import ErrorState from './common/error-state'
import { Button } from './ui/button'
import { Select } from './ui/select'
import { Switch } from './ui/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { cn } from '../lib/utils'
import { jsonRequest, requestJson } from '../lib/http'
import { RUN_NOUN } from '../lib/run-labels'
import { isCancellableStatus, isPausableStatus, isResumableStatus } from '../lib/status'
import type { Job, WorkflowPhase } from '../types'

export interface JobControlBarProps {
  job: Job
  workflowPhases: WorkflowPhase[]
  refreshing: boolean
  onRefresh: () => Promise<void>
  cancelling: boolean
  cancelError: string | null
  onCancel: () => Promise<void>
  pausing: boolean
  pauseError: string | null
  onPause: () => Promise<boolean | void>
  resuming: boolean
  resumeError: string | null
  resumePhase: string
  clearSession: boolean
  onResumePhaseChange: (value: string) => void
  onClearSessionChange: (value: boolean) => void
  onResume: (fromPhase?: string, shouldClearSession?: boolean) => Promise<void>
  /** Local optimistic patch for the interactive flag — surfaced separately
   *  so the bar can flip immediately while the PATCH is in flight. */
  interactiveOverride?: boolean
  onInteractiveChange: (next: boolean) => void
}

/**
 * Single, top-of-page control box for a single Run. Houses every action that
 * mutates the run's lifecycle (refresh, resume, interactive toggle) so the
 * detail page doesn't scatter controls across the right-hand sidebar.
 */
export default function JobControlBar({
  job,
  workflowPhases,
  refreshing,
  onRefresh,
  cancelling,
  cancelError,
  onCancel,
  pausing,
  pauseError,
  onPause,
  resuming,
  resumeError,
  resumePhase,
  clearSession,
  onResumePhaseChange,
  onClearSessionChange,
  onResume,
  interactiveOverride,
  onInteractiveChange,
}: JobControlBarProps) {
  const canResume = isResumableStatus(job.status)
  const canCancel = isCancellableStatus(job.status)
  const canPause = isPausableStatus(job.status, job.awaitingEvent)
  const interactiveValue = interactiveOverride ?? job.interactive
  const [togglePending, setTogglePending] = useState(false)
  const [toggleError, setToggleError] = useState<string | null>(null)

  // Reset the toggle error when the server-side value finally matches the
  // optimistic value — the user has moved on.
  useEffect(() => {
    if (interactiveOverride === undefined) setToggleError(null)
  }, [interactiveOverride])

  async function handleInteractiveChange(next: boolean) {
    setTogglePending(true)
    setToggleError(null)
    onInteractiveChange(next)
    try {
      await requestJson(`/jobs/${job.id}/interactive`, jsonRequest({ interactive: next }, { method: 'PATCH' }))
    } catch (err) {
      setToggleError(err instanceof Error ? err.message : 'Failed to update interactive mode')
      onInteractiveChange(!next)
    } finally {
      setTogglePending(false)
    }
  }

  return (
    <div className="space-y-3">
      <div
        className={cn(
          'flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-overlay/40 px-3 py-2',
          'sm:gap-3 sm:px-4',
        )}
      >
        <ControlGroupLabel label="Controls" />

        <Button
          variant="secondary"
          size="sm"
          onClick={() => void onRefresh()}
          disabled={refreshing || cancelling}
        >
          {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCcw />}
          Refresh
        </Button>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => void onCancel()}
          disabled={!canCancel || cancelling || resuming}
        >
          {cancelling ? <Loader2 className="animate-spin" /> : <Ban />}
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </Button>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => void onPause()}
          disabled={!canPause || pausing || cancelling || resuming}
          title={canPause ? 'Park the run at the next safe boundary so you can think and steer' : undefined}
        >
          {pausing ? <Loader2 className="animate-spin" /> : <Pause />}
          {pausing ? 'Pausing…' : 'Pause'}
        </Button>

        <ResumeControl
          job={job}
          workflowPhases={workflowPhases}
          canResume={canResume}
          resuming={resuming}
          resumePhase={resumePhase}
          clearSession={clearSession}
          onResumePhaseChange={onResumePhaseChange}
          onClearSessionChange={onClearSessionChange}
          onResume={onResume}
        />

        <Divider />

        <div className="flex items-center gap-2.5">
          <Switch
            checked={interactiveValue}
            onCheckedChange={handleInteractiveChange}
            disabled={togglePending}
            ariaLabel="Toggle interactive mode"
          />
          <div className="flex flex-col leading-tight">
            <span className="text-[12px] font-medium text-fg">
              {interactiveValue ? 'Interactive' : 'Autonomous'}
            </span>
            <span className="text-[11px] text-fg-subtle">
              {interactiveValue
                ? 'Will park at checkpoints'
                : 'Will run end-to-end'}
            </span>
          </div>
        </div>
      </div>

      {(cancelError || pauseError || resumeError || toggleError) ? (
        <div className="space-y-2">
          {cancelError ? <ErrorState title="Cancel failed" message={cancelError} /> : null}
          {pauseError ? <ErrorState title="Pause failed" message={pauseError} /> : null}
          {resumeError ? <ErrorState title="Resume failed" message={resumeError} /> : null}
          {toggleError ? <ErrorState title="Interactive toggle failed" message={toggleError} /> : null}
        </div>
      ) : null}
    </div>
  )
}

function ControlGroupLabel({ label }: { label: string }) {
  return (
    <span className="hidden text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle sm:inline">
      {label}
    </span>
  )
}

function Divider() {
  return <span className="hidden h-6 w-px bg-line sm:block" aria-hidden />
}

interface ResumeControlProps {
  job: Job
  workflowPhases: WorkflowPhase[]
  canResume: boolean
  resuming: boolean
  resumePhase: string
  clearSession: boolean
  onResumePhaseChange: (value: string) => void
  onClearSessionChange: (value: boolean) => void
  onResume: (fromPhase?: string, shouldClearSession?: boolean) => Promise<void>
}

function ResumeControl({
  job,
  workflowPhases,
  canResume,
  resuming,
  resumePhase,
  clearSession,
  onResumePhaseChange,
  onClearSessionChange,
  onResume,
}: ResumeControlProps) {
  const [open, setOpen] = useState(false)

  if (!canResume) {
    return (
      <span
        className="rounded-md border border-dashed border-line px-2.5 py-1 text-[12px] text-fg-subtle"
        title={`This ${RUN_NOUN.singularLower} can't be resumed from its current state.`}
      >
        Not resumable
      </span>
    )
  }

  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        onClick={() => void onResume(resumePhase || undefined, clearSession)}
        disabled={resuming}
      >
        {resuming ? <Loader2 className="animate-spin" /> : <Play />}
        {resuming ? 'Resuming…' : 'Resume'}
      </Button>

      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="secondary" aria-label="Resume options" className="px-2">
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-72 p-3">
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
                Resume from phase
              </label>
              <Select
                value={resumePhase}
                onChange={event => onResumePhaseChange(event.target.value)}
              >
                <option value="">Current phase ({job.phase})</option>
                {workflowPhases.map(phase => (
                  <option key={phase.name} value={phase.name}>
                    {phase.name}
                    {phase.name === job.phase ? ' (current)' : ''}
                  </option>
                ))}
              </Select>
            </div>
            <label className="flex items-start gap-2 text-[13px] text-fg-muted">
              <input
                type="checkbox"
                checked={clearSession}
                onChange={event => onClearSessionChange(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                Start with a fresh session.
                <span className="block text-[11px] text-fg-subtle">
                  Use when the current conversation history is no longer useful.
                </span>
              </span>
            </label>
            <div className="flex justify-end pt-1">
              <Button
                size="sm"
                onClick={() => {
                  setOpen(false)
                  void onResume(resumePhase || undefined, clearSession)
                }}
                disabled={resuming}
              >
                {resuming ? 'Resuming…' : 'Resume with options'}
              </Button>
            </div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
