import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../../components/ui/button'
import SettingsSection from '../../../components/settings/SettingsSection'
import { Input } from '../../../components/ui/input'
import { Switch } from '../../../components/ui/switch'
import SegmentedControl from '../../../components/ui/segmented-control'
import { requestJson, jsonRequest } from '../../../lib/http'
import { REVIEWS_PATH, type ReviewEngineStatus, type ReviewsSettings } from '../../../lib/reviews'
import { cn } from '../../../lib/utils'

type SavedSettings = ReviewsSettings & { running?: boolean; error?: string }

function saveMessage(saved: SavedSettings): { tone: 'ok' | 'warn'; text: string } {
  if (saved.error) return { tone: 'warn', text: `Saved, but the review engine did not start: ${saved.error}` }
  if (saved.enabled && saved.running) return { tone: 'ok', text: 'Saved. Coro is watching review requests now.' }
  if (saved.enabled) return { tone: 'warn', text: 'Saved and on, but this runner did not start the engine. Restart it.' }
  return { tone: 'ok', text: 'Saved. Reviews are off.' }
}

interface ChoiceProps<T extends string> {
  label: string
  hint: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}

function Choice<T extends string>({ label, hint, value, options, onChange }: ChoiceProps<T>) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="max-w-md space-y-0.5">
        <div className="text-sm font-medium text-fg">{label}</div>
        <p className="text-[12px] leading-4 text-fg-subtle">{hint}</p>
      </div>
      <SegmentedControl<T> options={options} value={value} onChange={onChange} size="sm" ariaLabel={label} />
    </div>
  )
}

function NumberField({ label, hint, value, onChange, step = 1 }: { label: string; hint: string; value: number; onChange: (value: number) => void; step?: number }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-fg">{label}</span>
      <Input type="number" min={0} step={step} value={Number.isFinite(value) ? value : ''} onChange={event => onChange(Number(event.target.value))} />
      <span className="block text-[12px] text-fg-subtle">{hint}</span>
    </label>
  )
}

export default function PrReviewsSection() {
  const [config, setConfig] = useState<ReviewsSettings>({ enabled: false })
  const [engine, setEngine] = useState<ReviewEngineStatus | null>(null)
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const edited = useRef(false)

  const loadEngine = () => requestJson<ReviewEngineStatus>(`${REVIEWS_PATH}/status`).then(setEngine).catch(() => setEngine(null))

  useEffect(() => {
    void requestJson<ReviewsSettings>('/reviews-settings').then(loaded => {
      if (!edited.current) setConfig(loaded)
    }).catch(() => undefined)
    void loadEngine()
  }, [])

  const update = (patch: Partial<ReviewsSettings>) => {
    edited.current = true
    setConfig(current => ({ ...current, ...patch }))
  }

  async function persist(next: ReviewsSettings) {
    setSaving(true)
    try {
      const saved = await requestJson<SavedSettings>('/reviews-settings', jsonRequest(next, { method: 'PUT' }))
      setMessage(saveMessage(saved))
      void loadEngine()
    } catch (err) {
      setMessage({ tone: 'warn', text: err instanceof Error ? err.message : 'Could not save' })
    } finally {
      setSaving(false)
    }
  }

  function setEnabled(checked: boolean) {
    const next = { ...config, enabled: checked }
    update({ enabled: checked })
    void persist(next)
  }

  const running = engine?.running === true
  return (
    <Card>
      <CardHeader>
        <CardTitle>PR reviews</CardTitle>
        <CardDescription>
          Coro reviews pull requests where you are a requested reviewer. A repository's <code>.coro/review.md</code> can
          only tighten these settings, never loosen them.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-overlay/40 px-4 py-3">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 text-sm font-medium text-fg">
              <span className={cn('size-2 rounded-full', running ? 'bg-success-400' : 'bg-fg-subtle')} aria-hidden />
              {running ? `Running as @${engine?.login ?? 'unknown'}` : config.enabled ? 'On, not running' : 'Off'}
            </div>
            <p className="text-[12px] text-fg-subtle">
              {running
                ? `${engine?.scms.join(', ') || 'No SCM'} · ${engine?.eventSource ?? 'poll'}${engine?.inbox?.lastPollAt ? ' · inbox checked recently' : ''}`
                : 'Turning this on starts the inbox right away. No restart needed.'}
              {' '}
              <Link to={REVIEWS_PATH} className="text-accent-300 hover:underline">Open Reviews</Link>
            </p>
          </div>
          <Switch checked={config.enabled === true} onCheckedChange={setEnabled} aria-label="Enable PR reviews" />
        </div>

        <div className="space-y-5">
          <Choice
            label="What Coro may post"
            hint="Draft leaves a pending review only you can see. Comments posts inline comments and holds the decision. Full may also request changes, and approves only when Approvals is Auto."
            value={config.autonomy ?? 'comment'}
            options={[
              { value: 'draft', label: 'Draft only' },
              { value: 'comment', label: 'Comments' },
              { value: 'full', label: 'Full review' },
            ]}
            onChange={autonomy => update({ autonomy })}
          />
          <Choice
            label="Approvals"
            hint="Never: Coro only comments. Recommend: approve and request changes wait for your verdict on the Reviews page. Auto: with Full, Coro approves as the review identity."
            value={config.approval ?? 'recommend'}
            options={[
              { value: 'never', label: 'Never' },
              { value: 'recommend', label: 'Recommend' },
              { value: 'auto', label: 'Auto' },
            ]}
            onChange={approval => update({ approval })}
          />
          <Choice
            label="Identity"
            hint="Self posts with your SCM token. Bot uses a separate app or account if one is configured."
            value={config.identity ?? 'self'}
            options={[
              { value: 'self', label: 'Me' },
              { value: 'bot', label: 'Bot' },
            ]}
            onChange={identity => update({ identity })}
          />
          <Choice
            label="How Coro hears about requests"
            hint="Polling works everywhere. Webhooks are faster but need a public URL."
            value={config.eventSource ?? 'poll'}
            options={[
              { value: 'poll', label: 'Poll' },
              { value: 'webhook', label: 'Webhook' },
              { value: 'both', label: 'Both' },
            ]}
            onChange={eventSource => update({ eventSource })}
          />
          <Choice
            label="Lowest severity to post"
            hint="Findings below this stay in Coro's ledger and are not posted."
            value={config.minSeverity ?? 'minor'}
            options={[
              { value: 'blocker', label: 'Blocker' },
              { value: 'major', label: 'Major' },
              { value: 'minor', label: 'Minor' },
              { value: 'nit', label: 'Nit' },
            ]}
            onChange={minSeverity => update({ minSeverity })}
          />
          <label className="flex items-center justify-between gap-4">
            <span className="space-y-0.5">
              <span className="block text-sm font-medium text-fg">Skip draft pull requests</span>
              <span className="block text-[12px] text-fg-subtle">Coro waits until the pull request is marked ready.</span>
            </span>
            <Switch checked={config.skipDrafts !== false} onCheckedChange={skipDrafts => update({ skipDrafts })} />
          </label>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField label="Budget per pull request (USD)" hint="Rounds pause when a pull request reaches this." step={0.5} value={config.budgetUsdPerPr ?? 5} onChange={budgetUsdPerPr => update({ budgetUsdPerPr })} />
          <NumberField label="Budget per day (USD)" hint="Across every review, reset at midnight UTC." step={1} value={config.budgetUsdPerDay ?? 25} onChange={budgetUsdPerDay => update({ budgetUsdPerDay })} />
          <NumberField label="Rounds per pull request" hint="A hard stop for long-running pull requests." value={config.maxRounds ?? 25} onChange={maxRounds => update({ maxRounds })} />
          <NumberField label="Wait after a push (seconds)" hint="Pushes within this window share one round." value={config.debounceSec ?? 180} onChange={debounceSec => update({ debounceSec })} />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={saving} onClick={() => void persist(config)}>{saving ? 'Saving…' : 'Save'}</Button>
          {message ? (
            <p className={cn('text-sm', message.tone === 'ok' ? 'text-fg-muted' : 'text-warning-400')}>{message.text}</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
