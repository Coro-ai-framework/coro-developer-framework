import { Switch } from '../../../components/ui/switch'
import { Select } from '../../../components/ui/select'
import SettingsSection from '../../../components/settings/SettingsSection'
import { useSettings } from '../SettingsContext'
import { jsonRequest, requestJson } from '../../../lib/http'
import type { IntakeMode } from '../../../lib/coach-mode'

export default function GeneralSection() {
  const { preferences, reload } = useSettings()
  const coach = preferences?.coachMode
  const intake = preferences?.intake

  const coachEnabled = coach?.enabled ?? true
  const graduateAfter = coach?.graduateAfterRuns ?? 5
  const intakeMode: IntakeMode = intake?.mode ?? (coachEnabled ? 'ai' : 'form')

  async function patchConfig(patch: Record<string, unknown>) {
    await requestJson('/config', jsonRequest(patch, { method: 'PUT' }))
    await reload()
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Coach mode"
        description="Safer defaults for new users — interactive checkpoints on by default until you graduate."
      >
        <label className="flex items-center justify-between gap-4 rounded-xl border border-line bg-overlay/30 p-4">
          <div>
            <div className="text-sm font-medium text-fg">Enable coach mode</div>
            <p className="mt-0.5 text-xs text-fg-muted">
              New runs default to Interactive mode and show extra guidance on the New Run page.
            </p>
          </div>
          <Switch
            checked={coachEnabled}
            onCheckedChange={checked => void patchConfig({ coachMode: { enabled: checked, graduateAfterRuns: graduateAfter } })}
            aria-label="Coach mode"
          />
        </label>
      </SettingsSection>

      <SettingsSection
        title="New run intake"
        description="Choose how the New Run page starts — AI conversation or the classic form."
      >
        <div className="space-y-2">
          <label className="text-[11px] font-medium uppercase tracking-[0.16em] text-fg-subtle">
            Default intake mode
          </label>
          <Select
            value={intakeMode}
            onChange={e => void patchConfig({ intake: { mode: e.target.value as IntakeMode } })}
          >
            <option value="ai">AI intake (recommended with coach mode)</option>
            <option value="form">Classic form</option>
            <option value="ask-each-time">Ask each time</option>
          </Select>
          <p className="text-xs text-fg-muted">
            AI intake uses your configured LLM to help shape a run brief before dispatch.
          </p>
        </div>
      </SettingsSection>
    </div>
  )
}
