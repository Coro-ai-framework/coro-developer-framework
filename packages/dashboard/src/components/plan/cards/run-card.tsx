import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ClipboardList, Loader2 } from 'lucide-react'
import CardShell from '../../activity/cards/card-shell'
import type { CardRenderProps } from '../../activity/cards/types'
import Field from '../../forms/field'
import { Badge } from '../../ui/badge'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Select } from '../../ui/select'
import { Textarea } from '../../ui/textarea'
import PhaseTimeline from '../../workflow/phase-timeline'
import { ApiError, jsonRequest, requestJson } from '../../../lib/http'
import { parseReviewersList, type RunDraft } from '../../../lib/intake-run'
import { findSimilarRuns } from '../../../lib/run-history'
import { usePlanSession } from '../../../providers/plan-session'
import { useWorkspaceTabs } from '../../../providers/workspace-tabs'
import { durationBandFor } from '../../../workflows'

export interface RunCardData {
  run: RunDraft
  state: 'draft' | 'superseded' | 'dispatched'
  jobId?: string
}

export default function RunCard({ data, itemId }: CardRenderProps<RunCardData>) {
  const { run, state, jobId } = data
  const session = usePlanSession()
  const navigate = useNavigate()
  const { closeTab } = useWorkspaceTabs()
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const workflow = session.workflows.find(w => w.workflowPath === run.workflowPath) ?? session.workflows[0]
  const similar = findSimilarRuns(session.jobs, run.description, run.repo)
  const formValid = Boolean(run.repo.trim() && run.serviceName.trim() && run.description.trim())
  const startBlocked = state !== 'draft' || session.busy || submitting || !formValid || !session.scmConnected

  function patchRun(patch: Partial<RunDraft>) {
    session.updateCard(itemId, { ...data, run: { ...run, ...patch } })
  }

  async function dispatch() {
    if (startBlocked) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const body = {
        type: 'job',
        workflowPath: run.workflowPath,
        repo: run.repo.trim(),
        serviceName: run.serviceName.trim(),
        description: run.description.trim(),
        reviewers: parseReviewersList(run.reviewers),
        interactive: run.interactive,
      }
      const result = await requestJson<{ jobId: string }>('/jobs', jsonRequest(body, { method: 'POST' }))
      session.markCardDispatched(itemId, result.jobId)
      await session.startNewConversation({ status: 'dispatched', dispatchedJobId: result.jobId })
      navigate(`/jobs/${result.jobId}`)
      closeTab('/jobs/new')
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        typeof err.payload === 'object' &&
        err.payload !== null &&
        (err.payload as { error?: string }).error === 'plugin_required'
      ) {
        setSubmitError(err.message)
        session.appendNotice({
          tone: 'error',
          text: 'A required provider is missing. Connect it in Settings, then try again.',
          action: { label: 'Open settings', to: '/settings#source-control' },
        })
      } else {
        setSubmitError(err instanceof ApiError ? err.message : (err as Error).message)
      }
      setSubmitting(false)
    }
  }

  const firstPhase = workflow?.phases?.[0]?.name ?? 'the first phase'
  const firstStop = run.interactive
    ? `Coro starts at ${firstPhase} and pauses at every checkpoint for your approval.`
    : 'Coro runs end-to-end and opens a PR. You can pause or message it mid-run.'

  const summary = (
    <div className="space-y-0.5">
      <div>
        {run.serviceName} · {run.repo}
      </div>
      <div>
        {workflow?.name ?? 'Workflow'} · {durationBandFor(run.workflowPath, workflow?.phases?.length ?? 0)}
      </div>
    </div>
  )

  const badges = (
    <>
      <Badge variant={run.interactive ? 'accent' : 'neutral'}>
        {run.interactive ? 'Interactive' : 'Autonomous'}
      </Badge>
      {state === 'superseded' ? <Badge variant="neutral">Superseded</Badge> : null}
    </>
  )

  const startTitle = !session.scmConnected
    ? 'Connect a source-control provider in Settings before starting a run.'
    : state === 'superseded'
      ? 'A newer run replaced this one.'
      : undefined

  const action =
    state === 'dispatched' && jobId ? (
      <Button asChild size="lg" className="w-full">
        <Link to={`/jobs/${jobId}`}>View run</Link>
      </Button>
    ) : (
      <Button
        type="button"
        size="lg"
        className="w-full"
        disabled={startBlocked}
        title={startTitle}
        onClick={() => void dispatch()}
      >
        {submitting ? <Loader2 className="animate-spin" /> : null}
        {submitting ? 'Starting run…' : 'Start run'}
      </Button>
    )

  return (
    <CardShell
      icon={ClipboardList}
      title="Run"
      summary={summary}
      badges={badges}
      action={action}
      dimmed={state !== 'draft'}
      defaultExpanded={false}
    >
      <Field label="Repository" required>
        <Input
          value={run.repo}
          onChange={e => patchRun({ repo: e.target.value })}
          disabled={state !== 'draft'}
        />
      </Field>
      <Field label="Service name" required>
        <Input
          value={run.serviceName}
          onChange={e => patchRun({ serviceName: e.target.value })}
          disabled={state !== 'draft'}
        />
      </Field>
      <Field label="Description" required>
        <Textarea
          rows={6}
          value={run.description}
          onChange={e => patchRun({ description: e.target.value })}
          disabled={state !== 'draft'}
        />
      </Field>
      <Field label="Reviewers">
        <Input
          value={run.reviewers}
          onChange={e => patchRun({ reviewers: e.target.value })}
          placeholder="alice, bob"
          disabled={state !== 'draft'}
        />
      </Field>
      <Field label="Workflow">
        <Select
          value={run.workflowPath}
          onChange={e => patchRun({ workflowPath: e.target.value })}
          disabled={state !== 'draft'}
        >
          {session.workflows.map(w => (
            <option key={w.id} value={w.workflowPath}>
              {w.name}
            </option>
          ))}
        </Select>
      </Field>
      <label className="flex items-center gap-2 text-[13px] text-fg">
        <input
          type="checkbox"
          checked={run.interactive}
          onChange={e => patchRun({ interactive: e.target.checked })}
          disabled={state !== 'draft'}
        />
        Interactive — pause at each checkpoint for approval
      </label>

      {workflow ? (
        <div className="space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">What will happen</div>
          <PhaseTimeline workflow={workflow} compact />
          <p className="text-[13px] leading-[1.6] text-fg-muted">{firstStop}</p>
          <p className="text-[12px] text-fg-subtle">
            {durationBandFor(run.workflowPath, workflow.phases?.length ?? 0)}
          </p>
        </div>
      ) : null}

      {similar.length > 0 ? (
        <div className="space-y-2">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">Similar past runs</div>
          <ul className="space-y-1.5">
            {similar.map(job => (
              <li key={job.id}>
                <Link
                  to={`/jobs/${job.id}`}
                  className="block rounded-lg border border-line bg-overlay/40 px-3 py-2 text-[12.5px] hover:border-line-strong"
                >
                  <span className="font-medium text-fg">
                    {typeof job.params?.serviceName === 'string' ? job.params.serviceName : job.id}
                  </span>
                  <span className="ml-2 text-fg-muted">{job.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {submitError ? <div className="text-sm text-danger-300">{submitError}</div> : null}
    </CardShell>
  )
}
