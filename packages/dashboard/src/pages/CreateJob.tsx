import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Edit3,
  Info,
  Loader2,
  Settings,
  Ticket,
  Workflow as WorkflowIcon,
} from 'lucide-react'
import PageHeader from '../components/common/page-header'
import Field from '../components/forms/field'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Switch } from '../components/ui/switch'
import { Textarea } from '../components/ui/textarea'
import WorkflowDetailsDialog from '../components/workflow/workflow-details-dialog'
import LayerBadge from '../components/intelligence/layer-badge'
import { jsonRequest, requestJson, ApiError } from '../lib/http'
import {
  FALLBACK_JOB_WORKFLOW,
  fetchLaunchableWorkflows,
  type WorkflowOption,
} from '../workflows'
import { cn } from '../lib/utils'

// ── Types ────────────────────────────────────────────────────────────────────

type SourceMode = 'manual' | 'ticket'

interface PluginManifest {
  id: string
  kind: string
  displayName: string
}

interface PluginEntry {
  manifest: PluginManifest
  installed?: boolean
  configured?: boolean
  active?: boolean
  source?: 'builtin' | 'dropin'
}

interface PluginsResponse {
  plugins: PluginEntry[]
  defaults: { scm?: string; tracker?: string }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CreateJob() {
  const navigate = useNavigate()

  // Workflow discovery — populated from the runner. Defaults to the
  // canonical implementation workflow so the page remains functional
  // while the request is in flight or if the runner is unreachable.
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([FALLBACK_JOB_WORKFLOW])
  const [workflowId, setWorkflowId] = useState<string>(FALLBACK_JOB_WORKFLOW.id)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [detailsWorkflow, setDetailsWorkflow] = useState<WorkflowOption | null>(null)
  const workflow =
    workflows.find(w => w.id === workflowId) ?? workflows[0] ?? FALLBACK_JOB_WORKFLOW

  // Form state — flat fields, only the ones each mode actually needs are
  // shown. Keeps the form approachable for first-time users.
  const [mode, setMode] = useState<SourceMode>('manual')
  const [serviceName, setServiceName] = useState('')
  const [repo, setRepo] = useState('')
  const [description, setDescription] = useState('')
  const [reviewers, setReviewers] = useState('')
  const [ticketId, setTicketId] = useState('')
  const [interactive, setInteractive] = useState(false)

  // Plugin discovery — drives the warning banner + the plugin selector
  // (only shown when more than one is active for a kind).
  const [scmPlugins, setScmPlugins] = useState<PluginManifest[]>([])
  const [trackerPlugins, setTrackerPlugins] = useState<PluginManifest[]>([])
  const [scmId, setScmId] = useState('')
  const [trackerId, setTrackerId] = useState('')
  const [pluginsLoaded, setPluginsLoaded] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const list = await fetchLaunchableWorkflows()
        if (list.length > 0) {
          setWorkflows(list)
          // Prefer the previously-selected id if it's still valid, else
          // the canonical `job` workflow, else the first entry.
          setWorkflowId(prev => {
            if (list.some(w => w.id === prev)) return prev
            const job = list.find(w => w.id === 'job')
            return (job ?? list[0]).id
          })
        }
      } catch {
        // Discovery is non-fatal — the fallback workflow keeps the page usable.
      }
    })()
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const data = await requestJson<PluginsResponse>('/plugins')
        const isActive = (e: PluginEntry) => e.active ?? e.configured ?? e.installed ?? false
        const scms = data.plugins.filter(p => p.manifest.kind === 'scm' && isActive(p)).map(p => p.manifest)
        const trackers = data.plugins
          .filter(p => p.manifest.kind === 'tracker' && isActive(p))
          .map(p => p.manifest)
        setScmPlugins(scms)
        setTrackerPlugins(trackers)
        setScmId(data.defaults.scm || (scms.length === 1 ? scms[0].id : ''))
        setTrackerId(data.defaults.tracker || (trackers.length === 1 ? trackers[0].id : ''))
      } catch {
        // Plugin discovery is non-fatal — the form still submits and the
        // runner resolves at dispatch time.
      } finally {
        setPluginsLoaded(true)
      }
    })()
  }, [])

  const blocker = useMemo<string | null>(() => {
    if (!pluginsLoaded) return null
    if (mode === 'manual' && scmPlugins.length === 0) {
      return 'Connect a source-control provider in Settings → Source control before dispatching a manual run.'
    }
    if (mode === 'ticket' && trackerPlugins.length === 0) {
      return 'Connect an issue tracker in Settings → Issue tracker before dispatching a ticket-driven run.'
    }
    return null
  }, [mode, pluginsLoaded, scmPlugins.length, trackerPlugins.length])

  const formValid = useMemo(() => {
    if (blocker) return false
    if (mode === 'manual') {
      return Boolean(serviceName.trim() && repo.trim() && description.trim())
    }
    return Boolean(ticketId.trim())
  }, [blocker, mode, serviceName, repo, description, ticketId])

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!formValid || submitting) return
    setError(null)
    setSubmitting(true)

    const params: Record<string, string> = {}
    if (scmId) params['scm'] = scmId
    if (trackerId) params['tracker'] = trackerId

    const body =
      mode === 'ticket'
        ? {
            type: 'job',
            workflowPath: workflow.workflowPath,
            jiraTicketId: ticketId.trim(),
            interactive,
            ...(Object.keys(params).length ? { params } : {}),
          }
        : {
            type: 'job',
            workflowPath: workflow.workflowPath,
            repo: repo.trim(),
            serviceName: serviceName.trim(),
            description: description.trim(),
            reviewers: reviewers
              .split(',')
              .map(s => s.trim())
              .filter(Boolean),
            interactive,
            ...(Object.keys(params).length ? { params } : {}),
          }

    try {
      const data = await requestJson<{ jobId: string }>('/jobs', jsonRequest(body, { method: 'POST' }))
      navigate(`/jobs/${data.jobId}`)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 pb-32">
      <PageHeader
        title="New run"
        description="Describe the work and Coro's agents will plan, code, review, and ship a pull request."
        actions={
          <Button variant="outline" onClick={() => navigate('/jobs')}>
            <ArrowLeft />
            Back
          </Button>
        }
      />

      {blocker ? (
        <div className="flex items-start gap-3 rounded-2xl border border-warning-500/30 bg-warning-500/8 p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-300" />
          <div className="flex-1 text-sm text-warning-200">
            <div className="font-medium">Setup needed</div>
            <p className="mt-0.5 text-warning-200/85">{blocker}</p>
          </div>
          <Button asChild size="sm" variant="outline">
            <Link to="/settings#source-control">
              <Settings />
              Open settings
            </Link>
          </Button>
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* ── How are you defining this run? ── */}
        <section className="space-y-3">
          <header>
            <h2 className="text-sm font-semibold text-fg">How would you like to start?</h2>
            <p className="text-xs text-fg-muted">Pick whichever feels most natural — both end in a pull request.</p>
          </header>
          <div className="grid gap-2 sm:grid-cols-2">
            <ModeCard
              icon={Edit3}
              title="Describe what to build"
              description="Free-form prompt. Best for ad-hoc work or quick experiments."
              selected={mode === 'manual'}
              onSelect={() => setMode('manual')}
            />
            <ModeCard
              icon={Ticket}
              title="From a tracker ticket"
              description="Coro pulls the title, description, and acceptance criteria from your tracker."
              selected={mode === 'ticket'}
              onSelect={() => setMode('ticket')}
              disabled={trackerPlugins.length === 0}
              disabledHint="Connect a tracker in Settings to use this mode."
            />
          </div>
        </section>

        {/* ── Mode-specific fields ── */}
        <section className="space-y-4 rounded-2xl border border-line bg-overlay/30 p-5">
          {mode === 'manual' ? (
            <ManualFields
              repo={repo}
              setRepo={setRepo}
              serviceName={serviceName}
              setServiceName={setServiceName}
              description={description}
              setDescription={setDescription}
              reviewers={reviewers}
              setReviewers={setReviewers}
              scmPlugins={scmPlugins}
              scmId={scmId}
              setScmId={setScmId}
            />
          ) : (
            <TicketFields
              ticketId={ticketId}
              setTicketId={setTicketId}
              trackerPlugins={trackerPlugins}
              trackerId={trackerId}
              setTrackerId={setTrackerId}
            />
          )}
        </section>

        {/* ── Run options ── */}
        <section className="space-y-3">
          <header>
            <h2 className="text-sm font-semibold text-fg">Run options</h2>
          </header>
          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-2xl border border-line bg-overlay/30 p-4 transition-colors hover:border-line-strong">
            <div>
              <div className="text-sm font-medium text-fg">Interactive checkpoints</div>
              <p className="mt-0.5 text-xs text-fg-muted">
                Pause for your approval at major phase boundaries. Off by default.
              </p>
            </div>
            <Switch checked={interactive} onCheckedChange={setInteractive} aria-label="Interactive mode" />
          </label>
        </section>

        {/* ── Advanced ── */}
        <section className="rounded-2xl border border-line bg-overlay/30">
          <button
            type="button"
            onClick={() => setAdvancedOpen(o => !o)}
            className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition-colors hover:bg-overlay/50"
            aria-expanded={advancedOpen}
          >
            <div>
              <div className="text-sm font-semibold text-fg">Advanced</div>
              <p className="text-xs text-fg-muted">
                Pick a workflow other than the default. Custom workflows added to your intelligence overlay show up here.
              </p>
            </div>
            <ChevronDown
              className={cn(
                'size-4 shrink-0 text-fg-muted transition-transform',
                advancedOpen && 'rotate-180',
              )}
            />
          </button>
          {advancedOpen ? (
            <div className="border-t border-line px-5 py-4 space-y-4">
              <Field
                label="Workflow"
                hint="The phase definition Coro will execute. The default fits most ad-hoc work."
              >
                <div className="space-y-2">
                  {workflows.map(option => {
                    const selected = option.id === workflowId
                    return (
                      <div
                        key={option.id}
                        className={cn(
                          'group flex items-start gap-3 rounded-xl border px-3 py-2.5 transition-colors',
                          selected
                            ? 'border-accent-500/50 bg-accent-500/10'
                            : 'border-line bg-overlay/40 hover:border-line-strong',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => setWorkflowId(option.id)}
                          className="flex flex-1 items-start gap-3 text-left"
                        >
                          <span
                            className={cn(
                              'mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-lg ring-1',
                              selected
                                ? 'bg-accent-500/20 ring-accent-500/40 text-accent-200'
                                : 'bg-overlay/60 ring-line text-fg-muted',
                            )}
                          >
                            <WorkflowIcon className="size-3.5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="text-sm font-medium text-fg">{option.name}</span>
                              {option.layer ? (
                                <LayerBadge layer={option.layer} overrides={option.overrides} size="sm" />
                              ) : null}
                              <span className="font-mono text-[10px] text-fg-subtle">{option.workflowPath}</span>
                              {option.phases ? (
                                <span className="text-[10px] text-fg-subtle">
                                  · {option.phases.length} phase{option.phases.length === 1 ? '' : 's'}
                                </span>
                              ) : null}
                            </div>
                            {option.description ? (
                              <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
                                {option.description}
                              </p>
                            ) : null}
                          </div>
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setDetailsWorkflow(option)}
                          className="shrink-0"
                        >
                          <Info />
                          Details
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </Field>
            </div>
          ) : null}
        </section>

        {error ? (
          <div className="rounded-2xl border border-danger-500/30 bg-danger-500/10 p-4 text-sm text-danger-200">
            {error}
          </div>
        ) : null}
      </form>

      {/* ── Sticky dispatch bar ── */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-canvas/85 backdrop-blur supports-[backdrop-filter]:bg-canvas/70">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-3">
          <div className="min-w-0 text-xs text-fg-muted">
            <div className="flex items-center gap-2">
              <span className="font-medium text-fg">{workflow.name}</span>
              <button
                type="button"
                onClick={() => setDetailsWorkflow(workflow)}
                className="inline-flex items-center gap-1 rounded text-[11px] text-fg-subtle transition-colors hover:text-accent-200"
              >
                <Info className="size-3" />
                Details
              </button>
            </div>
            <div className="truncate">
              {mode === 'manual'
                ? serviceName.trim() || 'Add a service name and prompt to dispatch'
                : ticketId.trim() || 'Enter a tracker ticket to dispatch'}
            </div>
          </div>
          <Button type="submit" size="lg" disabled={!formValid || submitting} onClick={handleSubmit}>
            {submitting ? <Loader2 className="animate-spin" /> : null}
            {submitting ? 'Dispatching…' : 'Dispatch run'}
            {!submitting ? <ArrowRight /> : null}
          </Button>
        </div>
      </div>

      <WorkflowDetailsDialog
        workflow={detailsWorkflow}
        open={detailsWorkflow !== null}
        onOpenChange={open => {
          if (!open) setDetailsWorkflow(null)
        }}
      />
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

interface ModeCardProps {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  selected: boolean
  onSelect: () => void
  disabled?: boolean
  disabledHint?: string
}

function ModeCard({ icon: Icon, title, description, selected, onSelect, disabled, disabledHint }: ModeCardProps) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onSelect}
      disabled={disabled}
      className={cn(
        'group relative overflow-hidden rounded-2xl border p-4 text-left transition-all',
        selected
          ? 'border-accent-500/50 bg-accent-500/10 shadow-[0_0_0_1px_rgba(97,114,255,0.3)]'
          : 'border-line bg-overlay/40 hover:border-line-strong hover:bg-overlay/60',
        disabled && 'cursor-not-allowed opacity-50',
      )}
      title={disabled ? disabledHint : undefined}
    >
      <span
        className={cn(
          'inline-flex size-9 items-center justify-center rounded-xl ring-1 transition-colors',
          selected
            ? 'bg-accent-500/20 ring-accent-500/40 text-accent-200'
            : 'bg-overlay/60 ring-line text-fg-muted group-hover:text-fg',
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="mt-3 text-sm font-medium text-fg">{title}</div>
      <p className="mt-1 text-xs leading-relaxed text-fg-muted">{description}</p>
    </button>
  )
}

interface ManualFieldsProps {
  repo: string
  setRepo: (v: string) => void
  serviceName: string
  setServiceName: (v: string) => void
  description: string
  setDescription: (v: string) => void
  reviewers: string
  setReviewers: (v: string) => void
  scmPlugins: PluginManifest[]
  scmId: string
  setScmId: (v: string) => void
}

function ManualFields(props: ManualFieldsProps) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Service name" required hint="Used as a label across runs.">
          <Input
            value={props.serviceName}
            onChange={e => props.setServiceName(e.target.value)}
            placeholder="Billing API"
            required
          />
        </Field>
        <Field label="Repository" required hint="owner/repo or workspace/repo, depending on your provider.">
          <Input
            value={props.repo}
            onChange={e => props.setRepo(e.target.value)}
            placeholder="my-org/billing-api"
            required
          />
        </Field>
      </div>

      <Field
        label="What should Coro build?"
        required
        hint="Be specific. Coro's planner reads this verbatim — include the goal, constraints, and any acceptance criteria."
      >
        <Textarea
          value={props.description}
          onChange={e => props.setDescription(e.target.value)}
          rows={6}
          placeholder="Add rate limiting to /api/users. Use the existing token bucket utility, and return clear retry-after headers when a caller exceeds the limit."
          required
        />
      </Field>

      <Field
        label="Reviewers"
        hint="Optional. Comma-separated usernames. They'll be added to the resulting pull request."
      >
        <Input
          value={props.reviewers}
          onChange={e => props.setReviewers(e.target.value)}
          placeholder="alice, bob"
        />
      </Field>

      {props.scmPlugins.length > 1 ? (
        <Field
          label="Source control"
          hint="Multiple SCM providers are configured. Choose one for this run."
        >
          <PluginPicker
            options={props.scmPlugins}
            value={props.scmId}
            onChange={props.setScmId}
          />
        </Field>
      ) : null}
    </div>
  )
}

interface TicketFieldsProps {
  ticketId: string
  setTicketId: (v: string) => void
  trackerPlugins: PluginManifest[]
  trackerId: string
  setTrackerId: (v: string) => void
}

function TicketFields(props: TicketFieldsProps) {
  return (
    <div className="space-y-4">
      <Field
        label="Ticket ID"
        required
        hint="Tracker-specific issue key (Jira: ENG-1234, Linear: ENG-12, GitHub Issues: 42)."
      >
        <Input
          value={props.ticketId}
          onChange={e => props.setTicketId(e.target.value)}
          placeholder="ENG-1234"
          required
          autoFocus
        />
      </Field>

      {props.trackerPlugins.length > 1 ? (
        <Field
          label="Issue tracker"
          hint="Multiple trackers are configured. Choose one for this run."
        >
          <PluginPicker
            options={props.trackerPlugins}
            value={props.trackerId}
            onChange={props.setTrackerId}
          />
        </Field>
      ) : null}
    </div>
  )
}

interface PluginPickerProps {
  options: PluginManifest[]
  value: string
  onChange: (id: string) => void
}

function PluginPicker({ options, value, onChange }: PluginPickerProps) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map(option => {
        const selected = option.id === value
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            className={cn(
              'rounded-xl border px-3 py-2.5 text-left text-sm transition-colors',
              selected
                ? 'border-accent-500/50 bg-accent-500/10 text-fg'
                : 'border-line bg-overlay/40 text-fg-muted hover:border-line-strong',
            )}
          >
            {option.displayName}
          </button>
        )
      })}
    </div>
  )
}
