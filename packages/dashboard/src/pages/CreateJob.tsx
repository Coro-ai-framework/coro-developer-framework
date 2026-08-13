import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { TooltipProvider } from '../components/ui/tooltip'
import WorkflowDetailsDialog from '../components/workflow/workflow-details-dialog'
import RunPreviewCard from '../components/run-preview-card'
import SamplePromptDrawer, { SamplePromptTrigger } from '../components/sample-prompt-drawer'
import IntakeChat from '../components/intake-chat'
import LayerBadge from '../components/intelligence/layer-badge'
import { jsonRequest, requestJson, ApiError } from '../lib/http'
import {
  FALLBACK_JOB_WORKFLOW,
  fetchLaunchableWorkflows,
  type WorkflowOption,
} from '../workflows'
import { cn } from '../lib/utils'
import { useJobs } from '../hooks/useJobs'
import { useLocalStorage } from '../hooks/use-local-storage'
import { deriveRunHistoryHints } from '../lib/run-history'
import {
  EMPTY_NEW_RUN_DRAFT,
  hasNewRunProgress,
  clearNewRunDraftStorage,
  NEW_RUN_DRAFT_KEY,
  type NewRunDraft,
  type NewRunPlanDraft,
} from '../lib/new-run-draft'
import { useRegisterWorkspaceTab, useWorkspaceTabs } from '../providers/workspace-tabs'
import {
  loadAskEachTimeChoice,
  loadSessionIntakeOverride,
  resolveIntakeMode,
  saveAskEachTimeChoice,
  saveSessionIntakeOverride,
  shouldShowCoachBanner,
  type CoachModeConfig,
  type IntakeMode,
} from '../lib/coach-mode'
import { firstPlaceholder, type PromptTemplate } from '../lib/prompt-templates'
import type { ConfigResponse } from '../pages/Settings/SettingsContext'
import GenericAuthPanel from '../components/wizard/GenericAuthPanel'
import { useProviderCatalog } from '../hooks/useProviderCatalog'
import type { StepKind } from '../lib/plugin-catalog-types'

// ── Types ────────────────────────────────────────────────────────────────────

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
  const { jobs } = useJobs(30_000)
  const { closeTab } = useWorkspaceTabs()
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useLocalStorage<NewRunDraft>(NEW_RUN_DRAFT_KEY, EMPTY_NEW_RUN_DRAFT)

  const patchDraft = useCallback((patch: Partial<NewRunDraft>) => {
    setDraft(previous => ({ ...previous, ...patch }))
  }, [setDraft])

  const clearNewRunDraft = useCallback(() => {
    clearNewRunDraftStorage()
    setDraft(EMPTY_NEW_RUN_DRAFT)
    closeTab('/jobs/new')
  }, [setDraft, closeTab])

  const {
    mode,
    serviceName,
    repo,
    description,
    reviewers,
    ticketId,
    interactive,
    workflowId,
    scmId,
    trackerId,
  } = draft

  const hasProgress = useMemo(() => hasNewRunProgress(draft), [draft])

  useRegisterWorkspaceTab(
    hasProgress
      ? {
          id: 'new-run',
          kind: 'run',
          path: '/jobs/new',
          title: 'New run',
          subtitle:
            mode === 'ticket'
              ? ticketId.trim() || 'Ticket'
              : serviceName.trim() || repo.trim() || 'Draft',
        }
      : null,
  )

  const [workflowsLoading, setWorkflowsLoading] = useState(true)
  const [coachMode, setCoachMode] = useState<CoachModeConfig | null>(null)
  const [intakePref, setIntakePref] = useState<IntakeMode | null>(null)
  const [surfaceOverride, setSurfaceOverride] = useState<'ai' | 'form' | null>(() => {
    const choice = loadSessionIntakeOverride()
    return choice === 'ai' || choice === 'form' ? choice : null
  })
  const [promptDrawerOpen, setPromptDrawerOpen] = useState(false)
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([FALLBACK_JOB_WORKFLOW])
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [detailsWorkflow, setDetailsWorkflow] = useState<WorkflowOption | null>(null)
  const workflow =
    workflows.find(w => w.id === workflowId) ?? workflows[0] ?? FALLBACK_JOB_WORKFLOW

  const runHistory = useMemo(() => deriveRunHistoryHints(jobs), [jobs])
  const showCoachBanner = shouldShowCoachBanner(coachMode ?? undefined)
  const coachActive = coachMode?.enabled !== false

  useEffect(() => {
    if (showCoachBanner) setAdvancedOpen(true)
  }, [showCoachBanner])

  useEffect(() => {
    void requestJson<ConfigResponse>('/config')
      .then(data => {
        setCoachMode(data.config?.coachMode ?? null)
        setIntakePref(resolveIntakeMode(data.config?.intake, data.config?.coachMode))
      })
      .catch(() => setIntakePref('form'))
  }, [])

  const persistedAskChoice = intakePref === 'ask-each-time' ? loadAskEachTimeChoice() : null
  const showIntakeChooser = intakePref === 'ask-each-time' && !surfaceOverride && !persistedAskChoice
  const resolvedIntakeMode: 'ai' | 'form' =
    surfaceOverride ?? persistedAskChoice ?? (intakePref === 'ai' ? 'ai' : 'form')
  const useAiIntake = resolvedIntakeMode === 'ai'

  const [interactiveInitialized, setInteractiveInitialized] = useState(false)

  useEffect(() => {
    if (!interactiveInitialized && coachMode !== null) {
      patchDraft({ interactive: coachActive && showCoachBanner })
      setInteractiveInitialized(true)
    }
  }, [coachMode, coachActive, showCoachBanner, interactiveInitialized, patchDraft])

  // Plugin discovery — drives the warning banner + the plugin selector
  // (only shown when more than one is active for a kind).
  const [scmPlugins, setScmPlugins] = useState<PluginManifest[]>([])
  const [trackerPlugins, setTrackerPlugins] = useState<PluginManifest[]>([])
  const [pluginsLoaded, setPluginsLoaded] = useState(false)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jitConnectKind, setJitConnectKind] = useState<StepKind | null>(null)
  const { plugins: catalogPlugins } = useProviderCatalog()

  useEffect(() => {
    void (async () => {
      try {
        const list = await fetchLaunchableWorkflows()
        if (list.length > 0) {
          setWorkflows(list)
          setDraft(previous => {
            if (list.some(w => w.id === previous.workflowId)) return previous
            const job = list.find(w => w.id === 'job')
            return { ...previous, workflowId: (job ?? list[0]).id }
          })
        }
      } catch {
        // Discovery is non-fatal
      } finally {
        setWorkflowsLoading(false)
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
        setDraft(previous => ({
          ...previous,
          scmId:
            previous.scmId ||
            data.defaults.scm ||
            (scms.length === 1 ? scms[0].id : ''),
          trackerId:
            previous.trackerId ||
            data.defaults.tracker ||
            (trackers.length === 1 ? trackers[0].id : ''),
        }))
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

  async function handleSubmit(interactiveChoice: boolean) {
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
            interactive: interactiveChoice,
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
            interactive: interactiveChoice,
            ...(Object.keys(params).length ? { params } : {}),
          }

    try {
      const data = await requestJson<{ jobId: string }>('/jobs', jsonRequest(body, { method: 'POST' }))
      clearNewRunDraft()
      navigate(`/jobs/${data.jobId}`)
    } catch (err) {
      if (
        err instanceof ApiError
        && err.status === 409
        && typeof err.payload === 'object'
        && err.payload !== null
        && (err.payload as { error?: string }).error === 'plugin_required'
      ) {
        const missingKind = (err.payload as { missingKind?: StepKind }).missingKind
        if (missingKind === 'scm' || missingKind === 'tracker') {
          setJitConnectKind(missingKind)
          setError('Connect a provider below, then retry dispatch.')
          setSubmitting(false)
          return
        }
      }
      setError(err instanceof ApiError ? err.message : (err as Error).message)
      setSubmitting(false)
    }
  }

  const jitPluginEntry = useMemo(() => {
    if (!jitConnectKind || !catalogPlugins) return null
    const kind = jitConnectKind === 'llm' ? 'executor' : jitConnectKind
    const matches = catalogPlugins.filter(p => p.kind === kind)
    const preferredId = jitConnectKind === 'scm' ? scmId : jitConnectKind === 'tracker' ? trackerId : undefined
    return matches.find(p => p.id === preferredId) ?? matches[0] ?? null
  }, [jitConnectKind, catalogPlugins, scmId, trackerId])

  function handleTemplateSelect(template: PromptTemplate) {
    patchDraft({ mode: template.mode })
    if (template.description) {
      patchDraft({ description: template.description })
      requestAnimationFrame(() => {
        const el = descriptionRef.current
        if (!el) return
        el.focus()
        const ph = firstPlaceholder(template.description)
        if (ph) el.setSelectionRange(ph.start, ph.end)
      })
    }
    if (template.suggestedWorkflow) {
      const match = workflows.find(w => w.workflowPath === template.suggestedWorkflow)
      if (match) patchDraft({ workflowId: match.id })
    }
  }

  const handlePlanChange = useCallback((plan: NewRunPlanDraft) => {
    setDraft(previous => ({ ...previous, plan }))
  }, [setDraft])

  const specificityHint = useMemo(() => {
    if (description.length <= 20) return null
    const hasSignal = /\/|\.|should|must/i.test(description)
    return hasSignal ? null : 'Add a file path or acceptance criterion to help Coro plan.'
  }, [description])

  if (showIntakeChooser && intakePref !== null) {
    return (
      <TooltipProvider>
        <div className="mx-auto w-full max-w-2xl space-y-6 pb-32">
          <PageHeader
            title="New run"
            description="How would you like to describe this run?"
            actions={
              <Button variant="outline" onClick={() => navigate('/jobs')}>
                <ArrowLeft />
                Back
              </Button>
            }
          />
          <IntakeModeChooser
            onChoose={mode => {
              saveAskEachTimeChoice(mode)
              setSurfaceOverride(mode)
            }}
          />
        </div>
      </TooltipProvider>
    )
  }

  if (useAiIntake && intakePref !== null) {
    return (
      <TooltipProvider>
        <div className="mx-auto w-full max-w-6xl space-y-6 pb-32">
          <PageHeader
            title="New run"
            description="Coro plan mode — describe your goal in conversation and review a brief before dispatching."
            actions={
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    saveSessionIntakeOverride('form')
                    setSurfaceOverride('form')
                  }}
                >
                  Use the form instead
                </Button>
                <Button variant="outline" onClick={() => navigate('/jobs')}>
                  <ArrowLeft />
                  Back
                </Button>
              </div>
            }
          />
          {showCoachBanner ? (
            <CoachBanner />
          ) : null}
          <IntakeChat
            workflows={workflows}
            jobs={jobs}
            initialPlan={draft.plan}
            onPlanChange={handlePlanChange}
            onDispatched={clearNewRunDraft}
            onUseForm={() => {
              saveSessionIntakeOverride('form')
              setSurfaceOverride('form')
            }}
            onNoLlm={() => {
              saveSessionIntakeOverride('form')
              setSurfaceOverride('form')
            }}
          />
        </div>
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider>
    <div className="mx-auto w-full max-w-6xl space-y-6 pb-32">
      <PageHeader
        title="New run"
        actions={
          <div className="flex items-center gap-2">
            {intakePref === 'ai' || coachActive ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  saveSessionIntakeOverride('ai')
                  setSurfaceOverride('ai')
                }}
              >
                Try Coro plan mode
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => navigate('/jobs')}>
              <ArrowLeft />
              Back
            </Button>
          </div>
        }
      />

      {showCoachBanner ? <CoachBanner /> : null}

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

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <form
          onSubmit={e => {
            e.preventDefault()
            void handleSubmit(coachActive && showCoachBanner ? true : interactive)
          }}
          className="space-y-6"
        >
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
              onSelect={() => patchDraft({ mode: 'manual' })}
            />
            <ModeCard
              icon={Ticket}
              title="From a tracker ticket"
              description="Coro pulls the title, description, and acceptance criteria from your tracker."
              selected={mode === 'ticket'}
              onSelect={() => patchDraft({ mode: 'ticket' })}
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
              setRepo={v => patchDraft({ repo: v })}
              serviceName={serviceName}
              setServiceName={v => patchDraft({ serviceName: v })}
              description={description}
              setDescription={v => patchDraft({ description: v })}
              reviewers={reviewers}
              setReviewers={v => patchDraft({ reviewers: v })}
              scmPlugins={scmPlugins}
              scmId={scmId}
              setScmId={v => patchDraft({ scmId: v })}
              recentRepos={runHistory.recentRepos}
              recentReviewers={runHistory.recentReviewers}
              descriptionRef={descriptionRef}
              specificityHint={specificityHint}
              onOpenExamples={() => setPromptDrawerOpen(true)}
            />
          ) : (
            <TicketFields
              ticketId={ticketId}
              setTicketId={v => patchDraft({ ticketId: v })}
              trackerPlugins={trackerPlugins}
              trackerId={trackerId}
              setTrackerId={v => patchDraft({ trackerId: v })}
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
                When on, Coro pauses at every workflow checkpoint for your approval.
              </p>
            </div>
            <Switch
              checked={interactive}
              onCheckedChange={v => patchDraft({ interactive: v })}
              aria-label="Interactive mode"
            />
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
                          onClick={() => patchDraft({ workflowId: option.id })}
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

        {jitConnectKind && jitPluginEntry ? (
          <div className="rounded-2xl border border-warning-500/30 bg-warning-500/8 p-4 space-y-3">
            <div className="text-sm font-medium text-fg">
              Connect {jitConnectKind === 'scm' ? 'source control' : 'issue tracker'}
            </div>
            <GenericAuthPanel
              entry={jitPluginEntry}
              draftConfig={{}}
              onChange={() => {}}
              onTestResult={result => {
                if (result.ok) {
                  setJitConnectKind(null)
                  setError(null)
                }
              }}
            />
          </div>
        ) : null}
        </form>

        <div className="hidden lg:block">
          <div className="sticky top-6">
            <RunPreviewCard
              workflow={workflow}
              interactive={interactive}
              mode={mode}
              serviceName={serviceName}
              repo={repo}
              ticketId={ticketId}
              formValid={formValid}
              loading={workflowsLoading}
            />
          </div>
        </div>
      </div>

      <div className="lg:hidden">
        <details className="rounded-2xl border border-line bg-overlay/30 p-4">
          <summary className="cursor-pointer text-sm font-medium text-fg">What will happen?</summary>
          <div className="mt-4">
            <RunPreviewCard
              workflow={workflow}
              interactive={interactive}
              mode={mode}
              serviceName={serviceName}
              repo={repo}
              ticketId={ticketId}
              formValid={formValid}
              loading={workflowsLoading}
            />
          </div>
        </details>
      </div>

      {/* ── Sticky dispatch bar ── */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-canvas/85 backdrop-blur supports-[backdrop-filter]:bg-canvas/70">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-3">
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
          <div className="flex flex-wrap items-center gap-2">
            {coachActive && showCoachBanner ? (
              <>
                <Button
                  type="button"
                  size="lg"
                  disabled={!formValid || submitting}
                  onClick={() => void handleSubmit(true)}
                >
                  {submitting ? <Loader2 className="animate-spin" /> : null}
                  Interactive
                  {!submitting ? <ArrowRight /> : null}
                </Button>
                <Button
                  type="button"
                  size="lg"
                  variant="secondary"
                  disabled={!formValid || submitting}
                  onClick={() => void handleSubmit(false)}
                >
                  Autonomous
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  size="lg"
                  disabled={!formValid || submitting}
                  onClick={() => void handleSubmit(true)}
                  variant="secondary"
                >
                  Interactive
                </Button>
                <Button
                  type="button"
                  size="lg"
                  disabled={!formValid || submitting}
                  onClick={() => void handleSubmit(false)}
                >
                  {submitting ? <Loader2 className="animate-spin" /> : null}
                  {submitting ? 'Dispatching…' : 'Autonomous'}
                  {!submitting ? <ArrowRight /> : null}
                </Button>
              </>
            )}
          </div>
        </div>
        <p className="mx-auto max-w-6xl px-6 pb-2 text-[10px] text-fg-subtle">
          Interactive: Coro pauses at every checkpoint for approval. You can switch to Autonomous mid-run.
        </p>
      </div>

      <SamplePromptDrawer
        open={promptDrawerOpen}
        onOpenChange={setPromptDrawerOpen}
        onSelect={handleTemplateSelect}
        hasExistingDescription={Boolean(description.trim())}
      />

      <WorkflowDetailsDialog
        workflow={detailsWorkflow}
        open={detailsWorkflow !== null}
        onOpenChange={open => {
          if (!open) setDetailsWorkflow(null)
        }}
      />
    </div>
    </TooltipProvider>
  )
}

function IntakeModeChooser({ onChoose }: { onChoose: (mode: 'ai' | 'form') => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <button
        type="button"
        onClick={() => onChoose('ai')}
        className="rounded-2xl border border-border bg-surface p-6 text-left transition hover:border-accent-500/40 hover:bg-accent-500/5"
      >
        <div className="text-[15px] font-semibold text-fg">Coro plan mode</div>
        <p className="mt-2 text-sm text-fg-muted">
          Talk through your goal with Coro. It asks clarifying questions and proposes a brief you
          can edit before dispatching.
        </p>
      </button>
      <button
        type="button"
        onClick={() => onChoose('form')}
        className="rounded-2xl border border-border bg-surface p-6 text-left transition hover:border-accent-500/40 hover:bg-accent-500/5"
      >
        <div className="text-[15px] font-semibold text-fg">Use the form</div>
        <p className="mt-2 text-sm text-fg-muted">
          Fill in repo, description, and reviewers directly — with previews, examples, and coach-mode
          guidance.
        </p>
      </button>
    </div>
  )
}

function CoachBanner() {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-accent-500/25 bg-accent-500/8 p-4 text-sm text-fg-muted">
      <Info className="mt-0.5 size-4 shrink-0 text-accent-300" />
      <p>
        <span className="font-medium text-fg">Coach mode is on.</span> Coro will pause at every workflow
        checkpoint so you can review. Turn this off in{' '}
        <Link to="/settings#general" className="text-accent-300 hover:underline">
          Settings
        </Link>{' '}
        or per-run below.
      </p>
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
  recentRepos: string[]
  recentReviewers: string[]
  descriptionRef: React.RefObject<HTMLTextAreaElement | null>
  specificityHint: string | null
  onOpenExamples: () => void
}

function ManualFields(props: ManualFieldsProps) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Service name"
          required
          hint="Used as a label across runs."
          tooltip="A short human-readable name shown on the Runs list and run detail header."
        >
          <Input
            value={props.serviceName}
            onChange={e => props.setServiceName(e.target.value)}
            placeholder="Billing API"
            required
          />
        </Field>
        <Field
          label="Repository"
          required
          hint="owner/repo or workspace/repo, depending on your provider."
          tooltip="The repo Coro clones to implement your change. Must match your SCM provider's slug format."
        >
          <Input
            value={props.repo}
            onChange={e => props.setRepo(e.target.value)}
            placeholder="my-org/billing-api"
            required
          />
          {props.recentRepos.length > 0 ? (
            <SuggestionChips
              label="Recent"
              items={props.recentRepos}
              onPick={props.setRepo}
            />
          ) : null}
        </Field>
      </div>

      <Field
        label="What should Coro build?"
        required
        hint="Be specific. Coro's planner reads this verbatim — include the goal, constraints, and any acceptance criteria."
        tooltip="This becomes the primary input for spec-writing and planning. Mention files, endpoints, and acceptance criteria when you can."
        action={<SamplePromptTrigger onClick={props.onOpenExamples} />}
      >
        <Textarea
          ref={props.descriptionRef}
          value={props.description}
          onChange={e => props.setDescription(e.target.value)}
          rows={6}
          placeholder="Add rate limiting to /api/users. Use the existing token bucket utility, and return clear retry-after headers when a caller exceeds the limit."
          required
        />
        <div className="mt-1 flex justify-between text-[11px] text-fg-subtle">
          <span>{props.specificityHint ?? '\u00a0'}</span>
          <span>{props.description.length} chars</span>
        </div>
      </Field>

      <Field
        label="Reviewers"
        hint="Optional. Comma-separated usernames. They'll be added to the resulting pull request."
        tooltip="Usernames on your git host who should review the PR Coro opens."
      >
        <Input
          value={props.reviewers}
          onChange={e => props.setReviewers(e.target.value)}
          placeholder="alice, bob"
        />
        {props.recentReviewers.length > 0 ? (
          <SuggestionChips
            label="Recent"
            items={props.recentReviewers}
            onPick={r => {
              const parts = props.reviewers.split(',').map(s => s.trim()).filter(Boolean)
              if (!parts.includes(r)) props.setReviewers([...parts, r].join(', '))
            }}
          />
        ) : null}
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

/**
 * Compact "Recent: foo · bar · baz" row that lives BELOW the matching
 * input so the input itself stays vertically aligned with sibling
 * fields in a grid (e.g. Service name ↔ Repository). Click a chip to
 * fill the parent field.
 */
function SuggestionChips({
  label,
  items,
  onPick,
}: {
  label: string
  items: string[]
  onPick: (value: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-fg-subtle">
      <span className="text-fg-subtle/80">{label}:</span>
      {items.map((item, i) => (
        <span key={item} className="inline-flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onPick(item)}
            className="rounded text-fg-muted underline-offset-2 transition-colors hover:text-accent-200 hover:underline"
          >
            {item}
          </button>
          {i < items.length - 1 ? <span aria-hidden className="text-fg-subtle/60">·</span> : null}
        </span>
      ))}
    </div>
  )
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
