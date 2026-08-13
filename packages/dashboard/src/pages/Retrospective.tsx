import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Microscope, Play, Sparkles } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import PageHeader from '../components/common/page-header'
import EmptyState from '../components/common/empty-state'
import ErrorState from '../components/common/error-state'
import StatusBadge from '../components/StatusBadge'
import FindingsList from '../components/retrospective/findings-list'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Skeleton } from '../components/ui/skeleton'
import { Switch } from '../components/ui/switch'
import { useRetrospectives } from '../hooks/useRetrospectives'
import { ApiError, jsonRequest, requestJson } from '../lib/http'
import { formatPreciseCurrency, formatRelativeTime } from '../lib/format'
import {
  availableTiers,
  CONTRIBUTION_SETTINGS_PATH,
  enabledTierLabels,
  RETROSPECTIVE_DEFAULT_TIERS,
  RETROSPECTIVE_DEFAULT_WINDOW,
  RETROSPECTIVE_MAX_WINDOW,
  RETROSPECTIVE_MIN_WINDOW,
  RETROSPECTIVE_PATH,
  TIER_META,
} from '../lib/retrospective'
import { isTerminalStatus } from '../lib/status'
import type { ConfigResponse } from './Settings/SettingsContext'
import type { RetrospectiveSummary, RetrospectiveTiers } from '../types'

interface DispatchResponse {
  jobId: string
}

export default function Retrospective() {
  const { retrospectives, loading, error, refetch } = useRetrospectives()

  const active = useMemo(
    () => retrospectives.find(entry => !isTerminalStatus(entry.status)),
    [retrospectives],
  )
  const finished = useMemo(
    () => retrospectives.filter(entry => isTerminalStatus(entry.status)),
    [retrospectives],
  )

  return (
    <div className="space-y-6">
      <PageHeader
        title="Retrospective"
        description="Coro reads its own run history, finds where its agents repeatedly struggle, and turns those patterns into reviewable improvements. Nothing ships until you approve it."
      />

      {error ? <ErrorState title="Could not load retrospectives" message={error} /> : null}

      {active ? (
        <ActiveRunCard retrospective={active} />
      ) : (
        <LaunchCard onLaunched={refetch} />
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-fg-subtle">
          Past retrospectives
        </h2>

        {loading && retrospectives.length === 0 ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-20 w-full" />
            ))}
          </div>
        ) : finished.length === 0 ? (
          <EmptyState
            icon={Microscope}
            title="No retrospectives yet"
            description="Run one once you have a handful of finished runs to learn from. It reads the history, not the code, so it costs a fraction of an implementation run."
          />
        ) : (
          finished.map(entry => <RetrospectiveCard key={entry.jobId} retrospective={entry} />)
        )}
      </section>
    </div>
  )
}

// ── Launching ────────────────────────────────────────────────────────────────

/**
 * Whether the runner can publish upstream, from its own resolved view
 * (which also accounts for the `CORO_UPSTREAM_*` env vars). Assumes "no"
 * until the answer arrives, and on failure: the cost of guessing wrong
 * that way is a disabled toggle, versus a run rejected at dispatch.
 */
function useUpstreamConfigured(): boolean {
  const [configured, setConfigured] = useState(false)

  useEffect(() => {
    let cancelled = false
    void requestJson<ConfigResponse>('/config')
      .then(data => {
        if (!cancelled) setConfigured(data.resolved?.upstreamConfigured === true)
      })
      .catch(() => {
        if (!cancelled) setConfigured(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return configured
}

function LaunchCard({ onLaunched }: { onLaunched: () => void | Promise<void> }) {
  const navigate = useNavigate()
  const [windowText, setWindowText] = useState(String(RETROSPECTIVE_DEFAULT_WINDOW))
  const [tiers, setTiers] = useState<RetrospectiveTiers>(RETROSPECTIVE_DEFAULT_TIERS)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const upstreamConfigured = useUpstreamConfigured()

  const parsedWindow = Number.parseInt(windowText, 10)
  const windowValid =
    Number.isFinite(parsedWindow) &&
    parsedWindow >= RETROSPECTIVE_MIN_WINDOW &&
    parsedWindow <= RETROSPECTIVE_MAX_WINDOW
  // What will actually be sent: a destination the runner cannot honour is
  // dropped here rather than rejected at dispatch.
  const effectiveTiers = availableTiers(tiers, upstreamConfigured)
  const anyTier = TIER_META.some(tier => effectiveTiers[tier.key])

  const start = async () => {
    setStarting(true)
    setError(null)
    try {
      const data = await requestJson<DispatchResponse>(
        RETROSPECTIVE_PATH,
        jsonRequest({ jobWindow: parsedWindow, tiers: effectiveTiers }, { method: 'POST' }),
      )
      await onLaunched()
      navigate(`/jobs/${data.jobId}`)
    } catch (err) {
      // 409 means another retrospective is already running — the poll will
      // swap this card for the active-run card, so just say so.
      const message =
        err instanceof ApiError && err.status === 409
          ? 'A retrospective is already running. Finish or cancel it first.'
          : err instanceof Error
            ? err.message
            : 'Failed to start retrospective'
      setError(message)
    } finally {
      setStarting(false)
    }
  }

  return (
    <Card>
      <CardHeader className="border-b border-line pb-4">
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-accent-300" aria-hidden />
          Run a retrospective
        </CardTitle>
        <CardDescription>
          The analyst reads the run history you point it at, groups repeated struggles into findings,
          then parks for your review before anything is proposed.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6 pt-5">
        <div className="space-y-1.5">
          <label htmlFor="retrospective-window" className="text-sm font-medium text-fg">
            Runs to analyse
          </label>
          <div className="flex items-center gap-3">
            <Input
              id="retrospective-window"
              type="number"
              min={RETROSPECTIVE_MIN_WINDOW}
              max={RETROSPECTIVE_MAX_WINDOW}
              value={windowText}
              onChange={event => setWindowText(event.target.value)}
              className="h-9 w-24 text-[13px]"
            />
            <span className="text-[12px] text-fg-subtle">
              Most recent finished runs, between {RETROSPECTIVE_MIN_WINDOW} and {RETROSPECTIVE_MAX_WINDOW}.
            </span>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium text-fg">Where approved findings may go</div>
          <div className="space-y-2">
            {TIER_META.map(tier => {
              const locked = Boolean(tier.requiresUpstream) && !upstreamConfigured
              return (
                <div
                  key={tier.key}
                  className="flex items-start gap-3 rounded-xl border border-line bg-overlay/40 px-3 py-2.5"
                >
                  <Switch
                    checked={effectiveTiers[tier.key]}
                    onCheckedChange={checked => setTiers(prev => ({ ...prev, [tier.key]: checked }))}
                    ariaLabel={tier.label}
                    className="mt-0.5"
                    disabled={locked}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-fg">{tier.label}</div>
                    <p className="text-[12px] leading-5 text-fg-muted">{tier.description}</p>
                    {locked ? (
                      <p className="mt-1 text-[12px] leading-5 text-fg-subtle">
                        Needs a contribution destination.{' '}
                        <Link to={CONTRIBUTION_SETTINGS_PATH} className="text-accent-300 hover:underline">
                          Set one up in Settings
                        </Link>
                        .
                      </p>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {error ? <ErrorState message={error} /> : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="primary"
            disabled={starting || !windowValid || !anyTier}
            onClick={() => void start()}
          >
            <Play />
            {starting ? 'Starting…' : 'Run retrospective'}
          </Button>
          {!anyTier ? (
            <span className="text-[12px] text-fg-muted">Pick at least one destination.</span>
          ) : !windowValid ? (
            <span className="text-[12px] text-fg-muted">
              Choose between {RETROSPECTIVE_MIN_WINDOW} and {RETROSPECTIVE_MAX_WINDOW} runs.
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

// ── In flight ────────────────────────────────────────────────────────────────

function ActiveRunCard({ retrospective }: { retrospective: RetrospectiveSummary }) {
  const needsReview = retrospective.awaitingApproval

  return (
    <Card className={needsReview ? 'border-warning-500/30' : undefined}>
      <CardHeader className="gap-3 border-b border-line pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {needsReview ? 'Findings are waiting for you' : 'Retrospective in progress'}
            <StatusBadge status={retrospective.status} />
          </CardTitle>
          <CardDescription>
            {needsReview
              ? 'Read the findings, then approve or send the analyst back from the run page.'
              : `Reading the last ${retrospective.jobWindow} runs. Findings appear here as soon as the analysis phase reports.`}
          </CardDescription>
        </div>
        <Button asChild variant={needsReview ? 'success' : 'secondary'} size="sm">
          <Link to={`/jobs/${retrospective.jobId}`}>
            {needsReview ? 'Review findings' : 'Watch the run'}
            <ArrowRight />
          </Link>
        </Button>
      </CardHeader>

      <CardContent className="space-y-4 pt-5">
        <RunFacts retrospective={retrospective} />
        {retrospective.findings.length > 0 ? (
          <FindingsList
            findings={retrospective.findings}
            outcomes={retrospective.outcomes}
            defaultExpandFirst
          />
        ) : null}
      </CardContent>
    </Card>
  )
}

// ── History ──────────────────────────────────────────────────────────────────

function RetrospectiveCard({ retrospective }: { retrospective: RetrospectiveSummary }) {
  const [open, setOpen] = useState(false)
  const shipped = retrospective.outcomes.filter(outcome => outcome.destination !== 'none').length

  return (
    <Card>
      <CardHeader className="gap-3 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Link to={`/jobs/${retrospective.jobId}`} className="font-mono text-sm hover:text-accent-300">
              {retrospective.jobId}
            </Link>
            <StatusBadge status={retrospective.status} />
          </CardTitle>
          <CardDescription>
            {retrospective.findings.length === 0
              ? 'No systemic findings — the runs in this window did not repeat a struggle.'
              : `${retrospective.findings.length} ${retrospective.findings.length === 1 ? 'finding' : 'findings'}, ${shipped} shipped.`}
          </CardDescription>
        </div>
        {retrospective.findings.length > 0 ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(value => !value)}>
            {open ? 'Hide findings' : 'Show findings'}
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-4">
        <RunFacts retrospective={retrospective} />
        {open ? (
          <FindingsList findings={retrospective.findings} outcomes={retrospective.outcomes} />
        ) : null}
      </CardContent>
    </Card>
  )
}

function RunFacts({ retrospective }: { retrospective: RetrospectiveSummary }) {
  const tierLabels = enabledTierLabels(retrospective.tiers)

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-fg-muted">
      <span>{retrospective.jobWindow} runs analysed</span>
      <span className="text-fg-subtle">·</span>
      <span>{formatPreciseCurrency(retrospective.costUsd)}</span>
      <span className="text-fg-subtle">·</span>
      <span>started {formatRelativeTime(retrospective.createdAt)}</span>
      {tierLabels.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {tierLabels.map(label => (
            <Badge key={label} variant="neutral">
              {label}
            </Badge>
          ))}
        </div>
      ) : null}
    </div>
  )
}
