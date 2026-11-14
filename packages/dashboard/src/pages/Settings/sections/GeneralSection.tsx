import { useState } from 'react'
import { Switch } from '../../../components/ui/switch'
import { SegmentedControl } from '../../../components/ui/segmented-control'
import SettingsSection from '../../../components/settings/SettingsSection'
import { useSettings } from '../SettingsContext'
import { jsonRequest, requestJson } from '../../../lib/http'
import { useLocalStorage } from '../../../hooks/use-local-storage'
import { ensureNotificationPermission, notificationsBlocked, NOTIFICATIONS_STORAGE_KEY } from '../../../lib/notifications'

const ACCESS_MODES = [
  { value: 'off', label: 'Off' },
  { value: 'ask', label: 'Ask' },
  { value: 'allow', label: 'Allow' },
] as const

const DEFAULT_ROWS = [
  { key: 'files', label: 'Read files', fallback: 'allow' },
  { key: 'filesWrite', label: 'Write scratch files', fallback: 'ask' },
  { key: 'shell', label: 'Shell', fallback: 'ask' },
  { key: 'web', label: 'Web', fallback: 'ask' },
  { key: 'runs', label: 'Control runs it started', fallback: 'ask' },
  { key: 'mcp', label: 'Other MCP servers', fallback: 'off' },
] as const

export default function GeneralSection() {
  const { preferences, reload } = useSettings()
  const coach = preferences?.coachMode
  const intake = preferences?.intake

  const coachEnabled = coach?.enabled ?? true
  const graduateAfter = coach?.graduateAfterRuns ?? 5
  const toolsOn = intake?.toolsEnabled !== false

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
              New runs default to Interactive mode and plan mode shows extra guidance.
            </p>
          </div>
          <Switch
            checked={coachEnabled}
            onCheckedChange={checked => void patchConfig({ coachMode: { enabled: checked, graduateAfterRuns: graduateAfter } })}
            ariaLabel="Coach mode"
          />
        </label>
      </SettingsSection>

      <NotificationsSetting />

      <SettingsSection
        title="Plan mode"
        description="Coro investigates the work with you in conversation before any run starts. Control what it may read here."
      >
        <label className="flex items-center justify-between gap-4 rounded-xl border border-line bg-overlay/30 p-4">
          <div>
            <div className="text-sm font-medium text-fg">Allow read-only lookups</div>
            <p className="mt-0.5 text-xs text-fg-muted">
              Let plan mode read tracker tickets and repository files while it investigates. Never writes.
            </p>
          </div>
          <Switch
            checked={toolsOn}
            onCheckedChange={checked => void patchConfig({ intake: { ...intake, toolsEnabled: checked } })}
            ariaLabel="Plan mode read-only tools"
          />
        </label>
        <label className="flex items-center justify-between gap-4 rounded-xl border border-line bg-overlay/30 p-4">
          <div>
            <div className="text-sm font-medium text-fg">Allow parallel subagents</div>
            <p className="mt-0.5 text-xs text-fg-muted">
              Let plan mode hand independent lookups to up to four read-only subagents that investigate in parallel. Faster on broad questions; uses more tokens per turn.
            </p>
          </div>
          <Switch
            checked={toolsOn && intake?.subagentsEnabled !== false}
            disabled={!toolsOn}
            onCheckedChange={checked => void patchConfig({ intake: { ...intake, subagentsEnabled: checked } })}
            ariaLabel="Plan mode subagents"
          />
        </label>
        <div className={toolsOn ? 'space-y-3' : 'space-y-3 opacity-50'}>
          <div>
            <div className="text-sm font-medium text-fg">Tool permissions</div>
            <p className="mt-0.5 text-xs text-fg-muted">
              Defaults for new conversations. A conversation can override these from its Tools menu.
            </p>
          </div>
          {DEFAULT_ROWS.map(row => {
            const value = intake?.permissions?.defaults?.[row.key] ?? row.fallback
            return (
              <div key={row.key} className="flex items-center justify-between gap-4 rounded-xl border border-line bg-overlay/30 p-4">
                <div className="text-sm text-fg">{row.label}</div>
                <SegmentedControl
                  size="sm"
                  ariaLabel={row.label}
                  options={ACCESS_MODES}
                  value={value}
                  onChange={next => {
                    if (!toolsOn) return
                    void patchConfig({
                      intake: {
                        ...intake,
                        permissions: {
                          ...intake?.permissions,
                          defaults: { ...intake?.permissions?.defaults, [row.key]: next },
                        },
                      },
                    })
                  }}
                />
              </div>
            )
          })}
          {(intake?.permissions?.allow?.length ?? 0) > 0 ? (
            <div className="rounded-xl border border-line bg-overlay/30 p-4">
              <div className="text-sm text-fg">Always allowed</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {intake!.permissions!.allow!.map(rule => (
                  <button
                    key={rule}
                    type="button"
                    disabled={!toolsOn}
                    className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] text-fg-muted hover:text-fg disabled:opacity-50"
                    onClick={() => void patchConfig({
                      intake: {
                        ...intake,
                        permissions: {
                          ...intake?.permissions,
                          allow: intake?.permissions?.allow?.filter(item => item !== rule) ?? [],
                        },
                      },
                    })}
                  >
                    {rule} ×
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </SettingsSection>
    </div>
  )
}

function NotificationsSetting() {
  const [enabled, setEnabled] = useLocalStorage(NOTIFICATIONS_STORAGE_KEY, true)
  const [blocked, setBlocked] = useState(notificationsBlocked)
  const desktop = typeof window !== 'undefined' && Boolean(window.coroDesktop)

  async function toggle(next: boolean) {
    if (next) {
      const granted = await ensureNotificationPermission()
      setBlocked(!granted)
      if (!granted) return
    }
    setEnabled(next)
  }

  return (
    <SettingsSection
      title="Notifications"
      description="Coro tells you when something needs you while you are looking elsewhere."
    >
      <label className="flex items-center justify-between gap-4 rounded-xl border border-line bg-overlay/30 p-4">
        <div>
          <div className="text-sm font-medium text-fg">Notify me when something needs me</div>
          <p className="mt-0.5 text-xs text-fg-muted">
            A run waiting for an answer, a review draft to approve, a plan-mode permission prompt, or a plan-mode reply.
            {desktop ? ' The dock badge always shows the count.' : ''}
          </p>
          {blocked && !desktop ? (
            <p className="mt-1 text-xs text-warning-300">Your browser is blocking notifications for this site. Allow them in the site settings.</p>
          ) : null}
        </div>
        <Switch
          checked={enabled && !blocked}
          onCheckedChange={checked => void toggle(checked)}
          ariaLabel="Notifications"
        />
      </label>
    </SettingsSection>
  )
}

