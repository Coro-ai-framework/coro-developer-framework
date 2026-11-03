import { useCallback, useEffect, useState, type ChangeEvent } from 'react'
import { RefreshCcw } from 'lucide-react'
import Field from '../../../components/forms/field'
import ChoiceGroup from '../../../components/settings/ChoiceGroup'
import SettingsNotice from '../../../components/settings/SettingsNotice'
import SettingsSection from '../../../components/settings/SettingsSection'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Select } from '../../../components/ui/select'
import { Switch } from '../../../components/ui/switch'
import { Textarea } from '../../../components/ui/textarea'
import { requestJson } from '../../../lib/http'
import {
  EVENT_LABELS,
  PRESET_LABELS,
  SOURCE_TICKET_EVENT_IDS,
  TICKETING_PRESET_IDS,
  TICKET_STATUS_CATEGORY_IDS,
  WORK_ITEM_TICKET_EVENT_IDS,
  blankToNull,
  effectiveValue,
  eventPath,
  parseLabels,
  presetOf,
  setField,
  setPreset,
  setStatusMapping,
  type TicketEventScope,
  type TicketingDoc,
  type TicketingPresets,
} from '../../../lib/ticketing-settings'
import { useSettings } from '../SettingsContext'

interface TrackerSummary {
  source: 'plugin' | 'mcp'
  id: string
  selector: string
  displayName: string
  status: string
}

interface DetectedTrackers {
  binding: TrackerSummary | null
  candidates: TrackerSummary[]
  reason: string
}

const STATUS_LABELS: Record<string, string> = {
  todo: 'To do',
  'in-progress': 'In progress',
  'in-review': 'In review',
  done: 'Done',
}

const WORK_ITEM_MODE_LABELS: Record<string, string> = {
  off: 'Off — no ticket per work item',
  subtasks: 'Sub-tasks of the run\'s ticket',
  linked: 'Separate tickets linked to the run\'s ticket',
  checklist: 'A checklist on the run\'s ticket',
}

export default function TicketManagementSection() {
  const { draft, setDraft, meta, pluginsCatalogue } = useSettings()
  const presets = meta?.resolved.ticketingPresets
  const doc = draft.ticketing

  if (!presets) {
    return (
      <SettingsSection title="Ticket management">
        <SettingsNotice title="Needs a newer runner">
          This runner does not report a ticket management policy. Update it to edit these settings.
        </SettingsNotice>
      </SettingsSection>
    )
  }

  const update = (next: TicketingDoc) => setDraft('ticketing', next)
  const value = <T,>(path: readonly string[]) => effectiveValue<T>(doc, presets, path)
  const set = (path: readonly string[], v: unknown) => update(setField(doc, presets, path, v))
  const enabled = value<boolean>(['enabled'])
  const trackerPlugins = (pluginsCatalogue?.plugins ?? [])
    .filter(p => p.manifest.kind === 'tracker' && p.installed)
    .map(p => ({ id: p.manifest.id, label: p.manifest.displayName }))

  return (
    <>
      <SettingsSection
        title="Ticket management"
        description="When jobs read, comment on, move, or create tickets. Teams work differently, so Coro only does what is switched on here."
      >
        <SettingsNotice tone="accent" title="With nothing set">
          Jobs read the run&apos;s ticket, put its key in the branch and PR, and comment when the job starts, opens a PR,
          and finishes. They never change a status or create a ticket until you turn that on below.
        </SettingsNotice>

        <ToggleRow
          title="Ticket updates"
          description="Off: jobs still read tickets but never write to the tracker."
          checked={enabled}
          onChange={next => set(['enabled'], next)}
        />

        <TrackerField
          value={value<string>(['tracker'])}
          plugins={trackerPlugins}
          onChange={next => set(['tracker'], next)}
        />
      </SettingsSection>

      <SettingsSection title="Preset" description="A starting point. Anything you change below is kept when you switch presets.">
        <ChoiceGroup
          name="ticketing-preset"
          value={presetOf(doc)}
          cols={2}
          onChange={preset => update(setPreset(doc, preset))}
          options={TICKETING_PRESET_IDS.map(id => ({
            value: id,
            label: PRESET_LABELS[id].title,
            description: PRESET_LABELS[id].description,
          }))}
        />
      </SettingsSection>

      <SettingsSection
        title="The run's ticket"
        description="What a job does to the ticket it was started from. Statuses are categories, mapped to your tracker's names under Status names."
      >
        <EventMatrix scope="sourceTicket" events={SOURCE_TICKET_EVENT_IDS} doc={doc} presets={presets} onChange={update} />
      </SettingsSection>

      <SettingsSection
        title="Work-item tickets"
        description="One ticket per work item the planner creates. Only for runs with a ticket and enough work items."
      >
        <Field label="Mode">
          <Select
            value={value<string>(['workItemTickets', 'mode'])}
            onChange={e => set(['workItemTickets', 'mode'], e.target.value)}
          >
            {Object.entries(WORK_ITEM_MODE_LABELS).map(([mode, label]) => (
              <option key={mode} value={mode}>{label}</option>
            ))}
          </Select>
        </Field>
        {value<string>(['workItemTickets', 'mode']) !== 'off' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Minimum work items" hint="Fewer than this and the run's ticket is enough.">
                <NumberInput
                  value={value<number>(['workItemTickets', 'minWorkItems'])}
                  min={1}
                  onChange={n => set(['workItemTickets', 'minWorkItems'], n)}
                />
              </Field>
              <Field label="Most tickets per job">
                <NumberInput
                  value={value<number>(['workItemTickets', 'maxPerJob'])}
                  min={1}
                  max={50}
                  onChange={n => set(['workItemTickets', 'maxPerJob'], n)}
                />
              </Field>
              <Field label="Issue type" hint="Blank uses the tracker's sub-task type.">
                <Input
                  value={value<string | null>(['workItemTickets', 'issueType']) ?? ''}
                  onChange={e => set(['workItemTickets', 'issueType'], blankToNull(e.target.value))}
                  placeholder="Sub-task"
                />
              </Field>
              <Field label="Project" hint="Blank uses the run's ticket's project.">
                <Input
                  value={value<string | null>(['workItemTickets', 'project']) ?? ''}
                  onChange={e => set(['workItemTickets', 'project'], blankToNull(e.target.value))}
                  placeholder="WS"
                />
              </Field>
              <Field label="Labels" hint="Comma-separated.">
                <LabelsInput
                  value={value<string[]>(['workItemTickets', 'labels'])}
                  onChange={labels => set(['workItemTickets', 'labels'], labels)}
                />
              </Field>
              <Field label="Assignee" hint={'"none", "sourceAssignee", "sourceReporter", or a tracker account id.'}>
                <Input
                  value={value<string>(['workItemTickets', 'assignee'])}
                  onChange={e => set(['workItemTickets', 'assignee'], e.target.value.trim() ? e.target.value : undefined)}
                />
              </Field>
            </div>
            <ToggleRow
              title="Only with a ticket"
              description="Skip work-item tickets when the run was not started from a ticket."
              checked={value<boolean>(['workItemTickets', 'requireSourceTicket'])}
              onChange={next => set(['workItemTickets', 'requireSourceTicket'], next)}
            />
            <ToggleRow
              title="Reuse existing tickets"
              description="Match work items to sub-tickets that already exist instead of creating duplicates."
              checked={value<boolean>(['workItemTickets', 'reuseExisting'])}
              onChange={next => set(['workItemTickets', 'reuseExisting'], next)}
            />
            <EventMatrix scope="workItemTickets" events={WORK_ITEM_TICKET_EVENT_IDS} doc={doc} presets={presets} onChange={update} />
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection
        title="Status names"
        description="Your tracker's name for each status category. Blank lets the job pick the tracker's closest status."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {TICKET_STATUS_CATEGORY_IDS.map(category => (
            <Field key={category} label={STATUS_LABELS[category] ?? category}>
              <Input
                value={(doc['statusMap'] as Record<string, string> | undefined)?.[category] ?? ''}
                onChange={e => update(setStatusMapping(doc, category, e.target.value))}
                placeholder="tracker default"
              />
            </Field>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title="Reading and linking">
        <ToggleRow
          title="Read tickets in plan mode"
          description="Plan mode can read the tracker. It never writes to it."
          checked={value<boolean>(['read', 'planMode'])}
          onChange={next => set(['read', 'planMode'], next)}
        />
        <ToggleRow
          title="Re-read comments each phase"
          description="Each phase starts by checking the run's ticket for new comments."
          checked={value<boolean>(['read', 'commentsAtPhaseStart'])}
          onChange={next => set(['read', 'commentsAtPhaseStart'], next)}
        />
        <ToggleRow
          title="Ticket key in branch names"
          checked={value<boolean>(['linking', 'branchName'])}
          onChange={next => set(['linking', 'branchName'], next)}
        />
        <ToggleRow
          title="Ticket key in PR titles"
          checked={value<boolean>(['linking', 'prTitle'])}
          onChange={next => set(['linking', 'prTitle'], next)}
        />
        <ToggleRow
          title="Ticket link in PR descriptions"
          checked={value<boolean>(['linking', 'prBody'])}
          onChange={next => set(['linking', 'prBody'], next)}
        />
      </SettingsSection>

      <SettingsSection title="Comments and new tickets">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Comment length">
            <Select
              value={value<string>(['comments', 'verbosity'])}
              onChange={e => set(['comments', 'verbosity'], e.target.value)}
            >
              <option value="brief">Brief</option>
              <option value="detailed">Detailed</option>
            </Select>
          </Field>
          <Field label="Comment prefix">
            <Input
              value={value<string>(['comments', 'prefix'])}
              onChange={e => set(['comments', 'prefix'], e.target.value)}
            />
          </Field>
          <Field label="Create a ticket for runs without one" hint="Ask: plan mode offers it on the run card.">
            <Select
              value={value<string>(['createSourceTicket', 'mode'])}
              onChange={e => set(['createSourceTicket', 'mode'], e.target.value)}
            >
              <option value="off">Never</option>
              <option value="ask">Ask in plan mode</option>
              <option value="auto">Always</option>
            </Select>
          </Field>
          <Field label="Project for new tickets">
            <Input
              value={value<string | null>(['createSourceTicket', 'project']) ?? ''}
              onChange={e => set(['createSourceTicket', 'project'], blankToNull(e.target.value))}
              placeholder="WS"
            />
          </Field>
        </div>
      </SettingsSection>

      <OverridesSection
        text={draft.ticketingOverridesText}
        onChange={text => setDraft('ticketingOverridesText', text)}
      />
    </>
  )
}

function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string
  description?: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-overlay/40 px-4 py-3.5">
      <div className="min-w-0">
        <div className="text-sm font-medium text-fg">{title}</div>
        {description ? <div className="text-[12px] text-fg-muted">{description}</div> : null}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} ariaLabel={title} />
    </div>
  )
}

function TrackerField({
  value,
  plugins,
  onChange,
}: {
  value: string
  plugins: Array<{ id: string; label: string }>
  onChange: (next: string) => void
}) {
  const [detected, setDetected] = useState<DetectedTrackers | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true)
    setError(null)
    try {
      setDetected(await requestJson<DetectedTrackers>(`/trackers/detected${refresh ? '?refresh=1' : ''}`))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(false)
  }, [load])

  const mcpOptions = (detected?.candidates ?? []).filter(c => c.source === 'mcp')
  const known = new Set(['auto', 'none', ...plugins.map(p => p.id), ...mcpOptions.map(c => c.selector)])

  return (
    <Field
      label="Tracker"
      hint={
        loading
          ? 'Checking which tracker MCP servers are connected…'
          : error
            ? `Could not check connected trackers: ${error}`
            : detected
              ? `Auto would use: ${detected.binding ? detected.binding.displayName : 'none'} — ${detected.reason}`
              : undefined
      }
      action={
        <Button type="button" variant="outline" size="sm" onClick={() => void load(true)} disabled={loading}>
          <RefreshCcw />
          {loading ? 'Checking…' : 'Recheck'}
        </Button>
      }
    >
      <Select value={value} onChange={e => onChange(e.target.value)}>
        <option value="auto">Auto — a tracker plugin, else the one connected tracker MCP server</option>
        {plugins.map(p => (
          <option key={p.id} value={p.id}>{p.label} (plugin)</option>
        ))}
        {mcpOptions.map(c => (
          <option key={c.selector} value={c.selector}>{c.displayName} ({c.status})</option>
        ))}
        {!known.has(value) ? <option value={value}>{value}</option> : null}
        <option value="none">None — never use a tracker</option>
      </Select>
    </Field>
  )
}

function EventMatrix({
  scope,
  events,
  doc,
  presets,
  onChange,
}: {
  scope: TicketEventScope
  events: readonly string[]
  doc: TicketingDoc
  presets: TicketingPresets
  onChange: (next: TicketingDoc) => void
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-line">
      <table className="w-full text-[13px]">
        <thead className="bg-overlay/40 text-[11px] uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="px-4 py-2 text-left font-medium">When</th>
            <th className="px-4 py-2 text-left font-medium">Comment</th>
            <th className="px-4 py-2 text-left font-medium">Move to</th>
          </tr>
        </thead>
        <tbody>
          {events.map(event => {
            const commentPath = eventPath(scope, event, 'comment')
            const statusPath = eventPath(scope, event, 'status')
            const comment = effectiveValue<boolean>(doc, presets, commentPath)
            const status = effectiveValue<string | null>(doc, presets, statusPath)
            const custom = status !== null && !(TICKET_STATUS_CATEGORY_IDS as readonly string[]).includes(status)
            return (
              <tr key={event} className="border-t border-line">
                <td className="px-4 py-2 text-fg">{EVENT_LABELS[event] ?? event}</td>
                <td className="px-4 py-2">
                  <Switch
                    size="sm"
                    checked={comment}
                    onCheckedChange={next => onChange(setField(doc, presets, commentPath, next))}
                    ariaLabel={`Comment when ${EVENT_LABELS[event] ?? event}`}
                  />
                </td>
                <td className="px-4 py-2">
                  <Select
                    value={status ?? ''}
                    onChange={e => onChange(setField(doc, presets, statusPath, e.target.value || null))}
                    aria-label={`Status when ${EVENT_LABELS[event] ?? event}`}
                  >
                    <option value="">No change</option>
                    {TICKET_STATUS_CATEGORY_IDS.map(category => (
                      <option key={category} value={category}>{STATUS_LABELS[category]}</option>
                    ))}
                    {custom ? <option value={status}>{status}</option> : null}
                  </Select>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function NumberInput({
  value,
  min,
  max,
  onChange,
}: {
  value: number
  min?: number
  max?: number
  onChange: (next: number | undefined) => void
}) {
  return (
    <Input
      type="number"
      min={min}
      max={max}
      value={String(value)}
      onChange={e => {
        const parsed = Number.parseInt(e.target.value, 10)
        onChange(Number.isInteger(parsed) ? parsed : undefined)
      }}
    />
  )
}

/** Commits on blur so a typed comma is not swallowed by re-parsing. */
function LabelsInput({ value, onChange }: { value: string[]; onChange: (labels: string[]) => void }) {
  const joined = value.join(', ')
  const [text, setText] = useState(joined)
  useEffect(() => setText(joined), [joined])
  return (
    <Input
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={() => onChange(parseLabels(text))}
      placeholder="coro"
    />
  )
}

function OverridesSection({ text, onChange }: { text: string; onChange: (text: string) => void }) {
  let parseError: string | null = null
  try {
    const parsed = JSON.parse(text || '[]') as unknown
    if (!Array.isArray(parsed)) parseError = 'Overrides must be a JSON array.'
  } catch (err) {
    parseError = (err as Error).message
  }
  return (
    <SettingsSection
      title="Overrides"
      description={
        <span>
          Different rules for some repositories or ticket projects. Each entry needs a <code>match</code> with a{' '}
          <code>repo</code>, a <code>project</code>, or both, plus any of the fields above. For example:{' '}
          <code>{'[{ "match": { "project": "OPS" }, "preset": "status-sync" }]'}</code>.
          Project matches win over repo matches, and a match on both wins over either.
        </span>
      }
    >
      <Textarea
        value={text}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
        spellCheck={false}
        rows={8}
        className="font-mono text-[12px]"
      />
      {parseError ? <SettingsNotice tone="danger">{parseError}</SettingsNotice> : null}
    </SettingsSection>
  )
}
