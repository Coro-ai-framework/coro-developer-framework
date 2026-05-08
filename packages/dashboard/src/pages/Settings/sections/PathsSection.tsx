import { useState } from 'react'
import { FolderOpen, Loader2 } from 'lucide-react'
import { Input } from '../../../components/ui/input'
import { Button } from '../../../components/ui/button'
import Field from '../../../components/forms/field'
import SettingsSection from '../../../components/settings/SettingsSection'
import { useSettings } from '../SettingsContext'
import { ApiError, jsonRequest, requestJson } from '../../../lib/http'

interface RevealResponse {
  ok: boolean
  path?: string
  error?: string
}

function RevealButton({ targetPath, label }: { targetPath: string | undefined; label: string }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Platform-friendly button label so Mac users see "Show in Finder" etc.
  const platform =
    typeof navigator !== 'undefined' && /Win/i.test(navigator.platform)
      ? 'explorer'
      : typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
        ? 'finder'
        : 'files'
  const buttonLabel =
    platform === 'finder' ? 'Show in Finder' : platform === 'explorer' ? 'Show in Explorer' : 'Open folder'

  async function reveal() {
    if (!targetPath) return
    setErr(null)
    setBusy(true)
    try {
      const res = await requestJson<RevealResponse>(
        '/system/reveal',
        jsonRequest({ path: targetPath, create: true }, { method: 'POST' }),
      )
      if (!res.ok) setErr(res.error ?? 'Could not open folder')
    } catch (caught) {
      setErr(caught instanceof ApiError ? caught.message : (caught as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 flex items-center gap-3">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void reveal()}
        disabled={!targetPath || busy}
        title={targetPath ?? `${label} not configured`}
      >
        {busy ? <Loader2 className="animate-spin" /> : <FolderOpen />}
        {buttonLabel}
      </Button>
      {err ? <span className="text-[11px] text-danger-300">{err}</span> : null}
    </div>
  )
}

export default function PathsSection() {
  const { draft, setDraft, meta } = useSettings()

  // Effective paths: the explicit override if set, else the runner-resolved
  // default. The OS-specific default is whatever the runner reports — on
  // Windows that is `C:\Users\<name>\.coro\...`, on macOS/Linux `~/.coro/...`.
  const effectiveIntelligenceDir = draft.intelligenceDir.trim() || meta?.resolved.intelligenceDir
  const effectiveWorkingDir = draft.workingDir.trim() || meta?.resolved.workingDir

  return (
    <SettingsSection
      title="Paths"
      description="Filesystem locations the runner uses for intelligence materialisation and working repositories. Defaults are usually fine."
    >
      <Field
        label="Intelligence directory"
        hint="Leave blank to use the resolved default."
      >
        <Input
          value={draft.intelligenceDir}
          onChange={event => setDraft('intelligenceDir', event.target.value)}
          placeholder={meta?.resolved.intelligenceDir ?? ''}
        />
        <RevealButton targetPath={effectiveIntelligenceDir} label="Intelligence directory" />
      </Field>
      <Field
        label="Intelligence git remote"
        hint="URL of your tenant intelligence Git repository. The runner clones it on first proposal and uses it when merging overlays."
      >
        <Input
          value={draft.intelligenceRemote}
          onChange={event => setDraft('intelligenceRemote', event.target.value)}
          placeholder="https://github.com/org/coro-intelligence.git"
        />
      </Field>
      <Field label="Working directory" hint="Where repositories are cloned during job execution.">
        <Input
          value={draft.workingDir}
          onChange={event => setDraft('workingDir', event.target.value)}
          placeholder={meta?.resolved.workingDir ?? ''}
        />
        <RevealButton targetPath={effectiveWorkingDir} label="Working directory" />
      </Field>

      {meta ? (
        <div className="grid gap-2 rounded-2xl border border-line bg-overlay/40 p-4 text-xs sm:grid-cols-2">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">Config path</div>
            <div className="mt-1 break-all font-mono text-fg-muted">{meta.configPath}</div>
            <RevealButton targetPath={meta.configPath} label="Config file" />
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">Mode</div>
            <div className="mt-1 font-mono text-fg-muted">{meta.mode}</div>
          </div>
        </div>
      ) : null}
    </SettingsSection>
  )
}

