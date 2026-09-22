import { Input } from '../../../components/ui/input'
import { Select } from '../../../components/ui/select'
import Field from '../../../components/forms/field'
import SecretInput from '../../../components/settings/SecretInput'
import SettingsNotice from '../../../components/settings/SettingsNotice'
import SettingsSection from '../../../components/settings/SettingsSection'
import { decisionModeLabel, MANAGE_SUMMARY, OBSERVE_SUMMARY } from '../../../lib/decision-mode'
import { useSettings, type DecisionModeDraft } from '../SettingsContext'

const SITES: Array<{ id: string; label: string; hint: string }> = [
  { id: 'overseer', label: 'Overseer', hint: 'End-of-phase faithfulness check. In Manage mode, can pause interactive jobs.' },
  { id: 'wake-gate', label: 'Wake gate', hint: 'Whether a webhook should resume a parked job. Plain-code bot filter runs first.' },
  { id: 'lane', label: 'Lane advisory', hint: 'Suggests a workflow-lane mismatch. Never auto-switches.' },
  { id: 'input-screen', label: 'Input screen', hint: 'Flags inbound comments that look like instruction overrides.' },
  { id: 'review-lens', label: 'Review lens', hint: 'Suggests a review focus. Never skips the review.' },
]

export default function DecisionLayerSection() {
  const { draft, setDraft, meta } = useSettings()
  const configured = meta?.resolved.decisionConfigured ?? false
  const mode = draft.decisionMode

  function setSite(id: string, value: '' | DecisionModeDraft) {
    const next = { ...draft.decisionSites }
    if (!value) delete next[id]
    else next[id] = value
    setDraft('decisionSites', next)
  }

  return (
    <SettingsSection
      title="Overseer"
      description="Optional. Jev plus Coro is Overseer: a check that watches whether a job stays faithful to what you asked. Coro runs the same without it. If the provider is unreachable, the job continues."
    >
      {!configured && mode === 'off' ? (
        <SettingsNotice title="Overseer is off">
          Jobs run without a faithfulness check. Observe mode records an on-track
          rating and leaves the job alone. Manage mode can pause an interactive
          job when that rating says the run has drifted.
        </SettingsNotice>
      ) : null}

      {mode === 'shadow' ? (
        <SettingsNotice tone="accent" title="Observe mode">
          {OBSERVE_SUMMARY} Nothing is paused, skipped, or denied because of the
          check. Switch to Manage mode after the ratings look right.
        </SettingsNotice>
      ) : null}

      {mode === 'live' ? (
        <SettingsNotice tone="accent" title="Manage mode">
          {MANAGE_SUMMARY} Non-interactive jobs are marked only. Sites below
          inherit Manage unless you override them.
        </SettingsNotice>
      ) : null}

      <Field
        label="Mode"
        hint="Observe records the rating. Manage lets that check pause an interactive job."
      >
        <Select
          value={draft.decisionMode}
          onChange={event => setDraft('decisionMode', event.target.value as DecisionModeDraft)}
        >
          <option value="off">Off</option>
          <option value="shadow">Observe — record only</option>
          <option value="live">Manage — can pause a job</option>
        </Select>
      </Field>

      <Field
        label="API key"
        hint="Required to turn the layer on. Falls back to CORO_DECISION_API_KEY or TYPESAFE_API_KEY if left blank on disk."
      >
        <SecretInput
          value={draft.decisionApiKey}
          onChange={event => setDraft('decisionApiKey', event.target.value)}
          placeholder="leave blank to use the environment"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Base URL" hint="Leave blank for the provider default.">
          <Input
            value={draft.decisionBaseUrl}
            onChange={event => setDraft('decisionBaseUrl', event.target.value)}
            placeholder="provider default"
          />
        </Field>
        <Field label="Model" hint="Pin a version. Blank uses the runner default.">
          <Input
            value={draft.decisionModel}
            onChange={event => setDraft('decisionModel', event.target.value)}
            placeholder="jev-1.13.0"
          />
        </Field>
      </div>

      <Field label="Timeout (ms)" hint="Blank uses 1500ms. Failures always continue the job.">
        <Input
          type="number"
          min={1}
          value={draft.decisionTimeoutMs}
          onChange={event => setDraft('decisionTimeoutMs', event.target.value)}
          placeholder="1500"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Overseer scope"
          hint="Which jobs the end-of-phase overseer watches. Default is every workflow."
        >
          <Select
            value={draft.decisionOverseerScope}
            onChange={event => setDraft('decisionOverseerScope', event.target.value as 'all' | 'campaigns' | 'off')}
          >
            <option value="all">All workflows</option>
            <option value="campaigns">Campaigns only</option>
            <option value="off">Off</option>
          </Select>
        </Field>
        <Field
          label="When flagged"
          hint="Park only applies to interactive jobs. Non-interactive jobs are always flag-only."
        >
          <Select
            value={draft.decisionOverseerOnFlag}
            onChange={event => setDraft('decisionOverseerOnFlag', event.target.value as 'park' | 'flag-only')}
          >
            <option value="park">Park interactive jobs</option>
            <option value="flag-only">Flag only</option>
          </Select>
        </Field>
      </div>

      <div className="space-y-3">
        <div>
          <div className="text-sm font-medium text-fg">Per-site overrides</div>
          <p className="mt-0.5 text-xs text-fg-muted">
            Inherit uses the mode above. A site can stay in Observe while another is in Manage.
          </p>
        </div>
        {SITES.map(site => (
          <Field key={site.id} label={site.label} hint={site.hint}>
            <Select
              value={draft.decisionSites[site.id] ?? ''}
              onChange={event => setSite(site.id, event.target.value as '' | DecisionModeDraft)}
            >
              <option value="">Inherit ({decisionModeLabel(draft.decisionMode)})</option>
              <option value="off">Off</option>
              <option value="shadow">Observe</option>
              <option value="live">Manage</option>
            </Select>
          </Field>
        ))}
      </div>
    </SettingsSection>
  )
}
