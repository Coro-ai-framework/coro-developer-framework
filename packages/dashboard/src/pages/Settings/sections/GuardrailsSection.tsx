import { useMemo, useState, type ChangeEvent } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import SettingsSection from '../../../components/settings/SettingsSection'
import SettingsNotice from '../../../components/settings/SettingsNotice'
import Field from '../../../components/forms/field'
import { Input } from '../../../components/ui/input'
import { Switch } from '../../../components/ui/switch'
import { cn } from '../../../lib/utils'
import { useSettings, type GuardrailRuleDraft } from '../SettingsContext'

function scopeLabel(rule: GuardrailRuleDraft): string {
  const parts = [`on ${rule.on}`]
  if (rule.during?.length) parts.push(`during ${rule.during.join(', ')}`)
  return parts.join(' · ')
}

function PrDescriptionFields({
  rule,
  onConfigChange,
}: {
  rule: GuardrailRuleDraft
  onConfigChange: (config: Record<string, unknown>) => void
}) {
  const config = rule.config ?? {}
  const minLength = typeof config.minLength === 'number' ? config.minLength : 80
  const headings = Array.isArray(config.requiredHeadings)
    ? (config.requiredHeadings as string[]).join(', ')
    : '## What'

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Minimum description length">
        <Input
          type="number"
          min={1}
          value={minLength}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const n = Number(e.target.value)
            onConfigChange({
              ...config,
              minLength: Number.isFinite(n) ? n : 80,
            })
          }}
        />
      </Field>
      <Field label="Required headings (comma-separated)">
        <Input
          value={headings}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            onConfigChange({
              ...config,
              requiredHeadings: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
            })
          }}
        />
      </Field>
    </div>
  )
}

function PrDiffSizeFields({
  rule,
  onConfigChange,
}: {
  rule: GuardrailRuleDraft
  onConfigChange: (config: Record<string, unknown>) => void
}) {
  const config = rule.config ?? {}
  const maxLines = typeof config.maxLines === 'number' ? config.maxLines : 500
  const maxFiles = typeof config.maxFiles === 'number' ? config.maxFiles : 40

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Max diff lines">
        <Input
          type="number"
          min={1}
          value={maxLines}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const n = Number(e.target.value)
            onConfigChange({ ...config, maxLines: Number.isFinite(n) ? n : 500 })
          }}
        />
      </Field>
      <Field label="Max changed files">
        <Input
          type="number"
          min={1}
          value={maxFiles}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const n = Number(e.target.value)
            onConfigChange({ ...config, maxFiles: Number.isFinite(n) ? n : 40 })
          }}
        />
      </Field>
    </div>
  )
}

export default function GuardrailsSection() {
  const {
    draft,
    setDraft,
    setGuardrailRuleEnabled,
    setGuardrailRuleConfig,
    meta,
  } = useSettings()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [parseError, setParseError] = useState<string | null>(null)

  const scriptRules = useMemo(
    () => draft.guardrailRules.filter(r => r.check === 'script'),
    [draft.guardrailRules],
  )

  const builtinRules = useMemo(
    () => draft.guardrailRules.filter(r => r.check !== 'script'),
    [draft.guardrailRules],
  )

  const scriptsDir = meta?.resolved?.guardrails?.scriptsDir ?? '~/.coro/guardrails'

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Enable guardrails"
        description="When off, the runner skips all guardrail checks. Shipped defaults stay in the Coro package; this toggle controls whether they run."
      >
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm text-fg-muted">Enforce guardrails on jobs</span>
          <Switch
            checked={draft.guardrailsEnabled}
            onCheckedChange={(checked: boolean) => setDraft('guardrailsEnabled', checked)}
          />
        </div>
      </SettingsSection>

      {builtinRules.map(rule => (
        <SettingsSection
          key={rule.id}
          title={rule.title ?? rule.id}
          description={rule.description}
          status={rule.source === 'override' ? 'warn' : undefined}
          statusLabel={rule.source === 'override' ? 'modified' : rule.source === 'bundled' ? 'default' : undefined}
          action={
            <Switch
              checked={rule.enabled}
              disabled={!draft.guardrailsEnabled}
              onCheckedChange={(checked: boolean) => setGuardrailRuleEnabled(rule.id, checked)}
            />
          }
          footer={<span className="text-fg-subtle">{scopeLabel(rule)}</span>}
        >
          {rule.enabled && draft.guardrailsEnabled ? (
            rule.check === 'pr-description' ? (
              <PrDescriptionFields
                rule={rule}
                onConfigChange={config => setGuardrailRuleConfig(rule.id, config)}
              />
            ) : rule.check === 'pr-diff-size' ? (
              <PrDiffSizeFields
                rule={rule}
                onConfigChange={config => setGuardrailRuleConfig(rule.id, config)}
              />
            ) : (
              <SettingsNotice tone="neutral">
                No dashboard fields for check <code>{rule.check}</code>. Edit advanced JSON below.
              </SettingsNotice>
            )
          ) : (
            <p className="text-sm text-fg-muted">Rule disabled.</p>
          )}
        </SettingsSection>
      ))}

      {scriptRules.length > 0 ? (
        <SettingsSection
          title="Custom script rules"
          description="Rules that run JavaScript from your guardrails folder. Edit the script file on disk; the runner loads it on the next tool call."
        >
          <ul className="space-y-3">
            {scriptRules.map(rule => (
              <li
                key={rule.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-overlay/30 px-4 py-3"
              >
                <div>
                  <p className="font-medium text-sm">{rule.title ?? rule.id}</p>
                  <p className="text-xs text-fg-muted font-mono">
                    {scriptsDir}/{rule.script}.mjs
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                      rule.scriptFileExists
                        ? 'bg-success/15 text-success'
                        : 'bg-danger/15 text-danger',
                    )}
                  >
                    {rule.scriptFileExists ? 'script found' : 'script missing'}
                  </span>
                  <Switch
                    checked={rule.enabled}
                    disabled={!draft.guardrailsEnabled}
                    onCheckedChange={(checked: boolean) => setGuardrailRuleEnabled(rule.id, checked)}
                  />
                </div>
              </li>
            ))}
          </ul>
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Advanced"
        description="Override guardrails as raw JSON (same shape as ~/.coro/config.json guardrails.rules)."
        action={
          <button
            type="button"
            className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
            onClick={() => setAdvancedOpen(open => !open)}
          >
            {advancedOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            {advancedOpen ? 'Hide' : 'Show'}
          </button>
        }
      >
        {advancedOpen ? (
          <>
            <textarea
              value={draft.guardrailsRulesText}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
                setDraft('guardrailsRulesText', e.target.value)
                try {
                  JSON.parse(e.target.value)
                  setParseError(null)
                } catch (err) {
                  setParseError(`Invalid JSON: ${(err as Error).message}`)
                }
              }}
              spellCheck={false}
              rows={10}
              className="w-full rounded-md border border-line bg-bg font-mono text-[12px] p-3"
            />
            {parseError ? <SettingsNotice tone="danger">{parseError}</SettingsNotice> : null}
          </>
        ) : null}
      </SettingsSection>
    </div>
  )
}
