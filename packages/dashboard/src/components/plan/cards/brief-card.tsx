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
import { parseReviewersList, type BriefDraft } from '../../../lib/intake-brief'
import { findSimilarRuns } from '../../../lib/run-history'
import { usePlanSession } from '../../../providers/plan-session'
import { useWorkspaceTabs } from '../../../providers/workspace-tabs'
import { durationBandFor } from '../../../workflows'

export interface BriefCardData {
  brief: BriefDraft
  state: 'draft' | 'superseded' | 'dispatched'
  jobId?: string
}

export default function BriefCard({ data, itemId }: CardRenderProps<BriefCardData>) {
  const { brief, state, jobId } = data
  const session = usePlanSession()
  const navigate = useNavigate()
  const { closeTab } = useWorkspaceTabs()
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const workflow = session.workflows.find(w => w.workflowPath === brief.workflowPath) ?? session.workflows[0]
  const similar = findSimilarRuns(session.jobs, brief.description, brief.repo)
  const formValid = Boolean(brief.repo.trim() && brief.serviceName.trim() && brief.description.trim())
  const startBlocked = state !== 'draft' || session.busy || submitting || !formValid || !session.scmConnected

  function patchBrief(patch: Partial<BriefDraft>) {
    session.updateCard(itemId, { ...data, brief: { ...brief, ...patch } })
  }

  async function dispatch() {
    if (startBlocked) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      const body = {
        type: 'job',
        workflowPath: brief.workflowPath,
        repo: brief.repo.trim(),
        serviceName: brief.serviceName.trim(),
        description: brief.description.trim(),
        reviewers: parseReviewersList(brief.reviewers),
        interactive: brief.interactive,
      }
      const result = await requestJson<{ jobId: string }>('/jobs', jsonRequest(body, { method: 'POST' }))
      session.markCardDispatched(itemId, result.jobId)
      navigate(`/jobs/${result.jobId}`)
      session.reset()
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
  const firstStop = brief.interactive
    ? `Coro starts at ${firstPhase} and pauses at every checkpoint for your approval.`
    : 'Coro runs end-to-end and opens a PR. You can pause or message it mid-run.'

  const summary = (
    <div className="space-y-0.5">
      <div>
        {brief.serviceName} · {brief.repo}
      </div>
      <div>
        {workflow?.name ?? 'Workflow'} · {durationBandFor(brief.workflowPath, workflow?.phases?.length ?? 0)}
      </div>
    </div>
  )

  const badges = (
    <>
      <Badge variant={brief.interactive ? 'accent' : 'neutral'}>
        {brief.interactive ? 'Interactive' : 'Autonomous'}
      </Badge>
      {state === 'superseded' ? <Badge variant="neutral">Superseded</Badge> : null}
    </>
  )

  const startTitle = !session.scmConnected
    ? 'Connect a source-control provider in Settings before starting a run.'
    : state === 'superseded'
      ? 'A newer brief replaced this one.'
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
      title="Run brief"
      summary={summary}
      badges={badges}
      action={action}
      dimmed={state !== 'draft'}
      defaultExpanded={false}
    >
      <Field label="Repository" required>
        <Input
          value={brief.repo}
          onChange={e => patchBrief({ repo: e.target.value })}
          disabled={state !== 'draft'}
        />
      </Field>
      <Field label="Service name" required>
        <Input
          value={brief.serviceName}
          onChange={e => patchBrief({ serviceName: e.target.value })}
          disabled={state !== 'draft'}
        />
      </Field>
      <Field label="Description" required>
        <Textarea
          rows={6}
          value={brief.description}
          onChange={e => patchBrief({ description: e.target.value })}
          disabled={state !== 'draft'}
        />
      </Field>
      <Field label="Reviewers">
        <Input
          value={brief.reviewers}
          onChange={e => patchBrief({ reviewers: e.target.value })}
          placeholder="alice, bob"
          disabled={state !== 'draft'}
        />
      </Field>
      <Field label="Workflow">
        <Select
          value={brief.workflowPath}
          onChange={e => patchBrief({ workflowPath: e.target.value })}
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
          checked={brief.interactive}
          onChange={e => patchBrief({ interactive: e.target.checked })}
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
            {durationBandFor(brief.workflowPath, workflow.phases?.length ?? 0)}
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
