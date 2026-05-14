import { useMemo, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, CheckCircle2, Circle, Cpu, GitBranch, KanbanSquare, Loader2, Rocket, Sparkles } from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { useSettings } from '../../pages/Settings/SettingsContext'
import { evaluateReadiness } from '../../pages/Settings/readiness'
import { getSectionDescriptor } from '../../pages/Settings/sections'
import LlmProvidersSection from '../../pages/Settings/sections/LlmProvidersSection'
import SourceControlSection from '../../pages/Settings/sections/SourceControlSection'
import IssueTrackerSection from '../../pages/Settings/sections/IssueTrackerSection'
import SettingsStatusBadge from '../settings/StatusBadge'
import SettingsNotice from '../settings/SettingsNotice'

interface SetupWizardProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface StepDef {
  id: 'welcome' | 'llm' | 'git' | 'tracker' | 'review'
  title: string
  description: string
  body: ReactNode
  /** Required to proceed to next step. */
  requiredReadyKey?: 'llm-provider' | 'source-control'
  /** Show "Skip for now" instead of disabling Next when not ready. */
  skippable?: boolean
  /** Render the body full-bleed (no standard header / stepper above it). */
  fullBleed?: boolean
  /** Label override for the primary action button on this step. */
  nextLabel?: string
}

export default function SetupWizard({ open, onOpenChange }: SetupWizardProps) {
  const {
    draft,
    pluginsCatalogue,
    isDirty,
    save,
    saving,
    saveError,
    markFirstRunComplete,
  } = useSettings()
  const [stepIndex, setStepIndex] = useState(0)
  const [completing, setCompleting] = useState(false)

  const readiness = useMemo(
    () => evaluateReadiness({ draft, pluginsCatalogue }),
    [draft, pluginsCatalogue],
  )

  const steps: StepDef[] = [
    {
      id: 'welcome',
      title: 'Welcome to Coro',
      description: 'A short setup before your first agent run.',
      body: <WelcomeStep />,
      fullBleed: true,
      nextLabel: "Let's get started",
    },
    {
      id: 'llm',
      title: 'Pick your LLM provider',
      description:
        'The runner needs access to a model. Claude login is the recommended path — no manual token to manage.',
      body: <LlmProvidersSection embedded onConnected={() => setStepIndex(stepIdx => Math.min(stepIdx + 1, 4))} />,
      requiredReadyKey: 'llm-provider',
    },
    {
      id: 'git',
      title: 'Connect your code host',
      description: 'Git credentials power clone, branch, push, PR, and review actions.',
      body: <SourceControlSection />,
      requiredReadyKey: 'source-control',
    },
    {
      id: 'tracker',
      title: 'Connect an issue tracker',
      description:
        'Optional. Required only for campaigns that file an epic and child issues. You can do this later from Settings.',
      body: <IssueTrackerSection />,
      skippable: true,
    },
    {
      id: 'review',
      title: 'You are ready to go',
      description: 'Verify the readiness summary, then jump into the dashboard to create your first job.',
      body: <ReviewStep />,
    },
  ]

  const step = steps[stepIndex]
  const isLastStep = stepIndex === steps.length - 1
  const isFirstStep = stepIndex === 0
  const requiredReady = step.requiredReadyKey ? readiness.byId[step.requiredReadyKey].status === 'ok' : true
  const canAdvance = requiredReady || step.skippable === true

  async function finish() {
    setCompleting(true)
    try {
      if (isDirty) {
        await save()
      }
      markFirstRunComplete()
      onOpenChange(false)
    } finally {
      setCompleting(false)
    }
  }

  function nextLabel(): ReactNode {
    if (isLastStep) {
      if (completing || saving) return (<><Loader2 className="animate-spin" /> Finishing…</>)
      return (<><Rocket /> Open dashboard</>)
    }
    if (step.nextLabel) return (<>{step.nextLabel} <ArrowRight /></>)
    if (!requiredReady && step.skippable) return (<>Skip for now <ArrowRight /></>)
    return (<>Continue <ArrowRight /></>)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Override the default DialogContent layout: switch the grid to a
        strict flex column with no gap, give the body `flex-1 min-h-0
        overflow-y-auto`, and let the footer be `shrink-0`. The grid +
        `gap-4` default was leaving a gap row that pushed the footer
        past the dialog's max-height clip on shorter viewports.
      */}
      <DialogContent className="flex flex-col gap-0 max-h-[min(720px,calc(100vh-2rem))]">
        {step.fullBleed ? (
          <DialogHeader className="sr-only">
            <DialogTitle>{step.title}</DialogTitle>
            <DialogDescription>{step.description}</DialogDescription>
          </DialogHeader>
        ) : (
          <DialogHeader className="shrink-0">
            <div className="flex items-start justify-between gap-3 pr-10">
              <div className="space-y-1">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-subtle">
                  Step {stepIndex} of {steps.length - 1}
                </div>
                <DialogTitle>{step.title}</DialogTitle>
                <DialogDescription>{step.description}</DialogDescription>
              </div>
            </div>
            <ol className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-fg-subtle">
              {steps.slice(1).map((each, index) => {
                const realIndex = index + 1
                const completed = realIndex < stepIndex
                const current = realIndex === stepIndex
                return (
                  <li
                    key={each.id}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-2.5 py-1 transition-colors',
                      completed
                        ? 'border-success-500/30 bg-success-500/8 text-success-300'
                        : current
                          ? 'border-accent-500/35 bg-accent-500/8 text-fg'
                          : 'border-line bg-overlay/40',
                    )}
                  >
                    {completed ? <CheckCircle2 className="size-3.5" /> : <Circle className="size-3.5" />}
                    <span className="font-medium uppercase tracking-[0.16em]">{each.id}</span>
                  </li>
                )
              })}
            </ol>
          </DialogHeader>
        )}

        {step.fullBleed ? (
          <div className="flex-1 min-h-0 overflow-y-auto">{step.body}</div>
        ) : (
          <DialogBody className="flex-1 min-h-0 space-y-4">
            {saveError ? (
              <SettingsNotice tone="danger" title="Save failed">
                {saveError}
              </SettingsNotice>
            ) : null}
            {step.body}
          </DialogBody>
        )}

        <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-overlay/30 px-6 py-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => setStepIndex(idx => Math.max(0, idx - 1))}
            disabled={isFirstStep}
          >
            <ArrowLeft />
            Back
          </Button>

          <div className="flex items-center gap-2">
            {!isLastStep ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Close — finish later
              </Button>
            ) : null}
            {isLastStep ? (
              <Button type="button" onClick={() => void finish()} disabled={completing || saving}>
                {nextLabel()}
              </Button>
            ) : (
              <Button
                type="button"
                onClick={() => setStepIndex(idx => Math.min(steps.length - 1, idx + 1))}
                disabled={!canAdvance}
              >
                {nextLabel()}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ReviewStep() {
  const { draft, pluginsCatalogue, isDirty, dirtySections } = useSettings()
  const readiness = useMemo(
    () => evaluateReadiness({ draft, pluginsCatalogue }),
    [draft, pluginsCatalogue],
  )

  const items: { id: 'llm-provider' | 'source-control' | 'issue-tracker'; required: boolean }[] = [
    { id: 'llm-provider', required: true },
    { id: 'source-control', required: true },
    { id: 'issue-tracker', required: false },
  ]

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {items.map(item => {
          const descriptor = getSectionDescriptor(item.id)
          const status = readiness.byId[item.id]
          return (
            <div
              key={item.id}
              className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-overlay/40 px-4 py-3.5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-medium text-fg">
                  {descriptor.label}
                  {item.required ? (
                    <span className="rounded-full border border-line bg-overlay/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-fg-subtle">
                      Required
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 truncate text-xs text-fg-muted">{status.detail}</div>
              </div>
              <SettingsStatusBadge status={status.status} label={status.label} />
            </div>
          )
        })}
      </div>

      {isDirty ? (
        <SettingsNotice tone="accent" title="Unsaved changes">
          {dirtySections.size} section{dirtySections.size === 1 ? '' : 's'} have pending changes. They will be saved when you press <strong>Open dashboard</strong>.
        </SettingsNotice>
      ) : null}

      {!readiness.ready ? (
        <SettingsNotice tone="warning">
          You can still finish the wizard, but jobs will fail until the missing required sections are configured. Use <strong>Settings → Setup</strong> to come back any time.
        </SettingsNotice>
      ) : (
        <SettingsNotice tone="success">
          All required setup is complete. Click <strong>Open dashboard</strong> to start your first job.
        </SettingsNotice>
      )}
    </div>
  )
}

function WelcomeStep() {
  const highlights = [
    {
      icon: Cpu,
      title: 'Pick your model',
      copy: 'Sign in with Claude or paste an API key — Coro handles the rest.',
    },
    {
      icon: GitBranch,
      title: 'Connect your code host',
      copy: 'GitHub, Bitbucket, or GitLab. Branches, PRs, reviews — fully automated.',
    },
    {
      icon: KanbanSquare,
      title: 'Optional issue tracker',
      copy: 'Wire up Jira, Linear, or GitHub Issues for end-to-end campaigns.',
    },
  ]

  return (
    <div className="relative isolate overflow-hidden">
      {/* Layered ambient glows + grid — gives the welcome a futuristic feel
          without leaving the existing canvas/accent palette. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_60%_45%_at_50%_-10%,rgba(97,114,255,0.22),transparent_70%),radial-gradient(ellipse_50%_40%_at_85%_110%,rgba(56,189,248,0.16),transparent_75%),radial-gradient(ellipse_40%_35%_at_15%_115%,rgba(168,85,247,0.14),transparent_75%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.07] [background-image:linear-gradient(to_right,rgba(255,255,255,0.6)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.6)_1px,transparent_1px)] [background-size:36px_36px] [mask-image:radial-gradient(ellipse_at_center,black_40%,transparent_75%)]"
      />

      <div className="flex flex-col items-center gap-5 px-6 py-8 text-center sm:gap-6 sm:px-10 sm:py-10">
        {/* Brand orb — concentric arcs that read as a stylised "C", glowing. */}
        <div className="relative flex size-24 items-center justify-center">
          <span className="absolute inset-0 rounded-full bg-accent-500/20 blur-2xl" />
          <span className="relative inline-flex size-24 items-center justify-center rounded-3xl bg-gradient-to-br from-accent-500/25 via-accent-500/10 to-transparent ring-1 ring-accent-500/35 shadow-[0_0_60px_-20px_rgba(97,114,255,0.6)]">
            <svg viewBox="0 0 24 24" fill="none" className="size-12 text-accent-200 drop-shadow-[0_0_12px_rgba(125,150,255,0.55)]">
              <path
                d="M19 7.5A8 8 0 1 0 19 16.5"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
              <circle cx="18.25" cy="12" r="1.6" fill="currentColor" />
            </svg>
          </span>
        </div>

        <div className="space-y-3">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-accent-500/30 bg-accent-500/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-accent-200">
            <Sparkles className="size-3.5" />
            First-time setup
          </div>
          <h1 className="text-balance bg-gradient-to-b from-fg via-fg to-fg-muted bg-clip-text text-4xl font-semibold tracking-tight text-transparent sm:text-5xl">
            Welcome to Coro
          </h1>
          <p className="mx-auto max-w-xl text-pretty text-sm text-fg-muted sm:text-base">
            A plug-and-play AI harness for your SDLC. Coro turns your engineering process into deterministic, markdown-defined workflows — specialised agents plan, code, review, merge, and learn from every run your team controls.
          </p>
          <p className="mx-auto max-w-xl text-pretty text-xs text-fg-subtle sm:text-sm">
            A short three-step setup gets you wired up. You can revisit anything later from <strong className="text-fg-muted">Settings → Setup</strong>.
          </p>
        </div>

        <div className="grid w-full max-w-2xl gap-3 sm:grid-cols-3">
          {highlights.map(({ icon: Icon, title, copy }) => (
            <div
              key={title}
              className="group relative overflow-hidden rounded-2xl border border-line bg-overlay/40 p-4 text-left transition-colors hover:border-accent-500/30 hover:bg-overlay/60"
            >
              <div
                aria-hidden
                className="pointer-events-none absolute -right-6 -top-6 size-20 rounded-full bg-accent-500/10 blur-2xl transition-opacity group-hover:opacity-100"
              />
              <span className="relative inline-flex size-9 items-center justify-center rounded-xl bg-accent-500/12 ring-1 ring-accent-500/25 text-accent-200">
                <Icon className="size-4" />
              </span>
              <div className="relative mt-3 text-sm font-medium text-fg">{title}</div>
              <div className="relative mt-1 text-xs leading-relaxed text-fg-muted">{copy}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

