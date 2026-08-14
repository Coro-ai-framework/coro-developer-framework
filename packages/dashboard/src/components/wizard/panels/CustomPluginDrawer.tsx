import { type FormEvent, useEffect, useState } from 'react'
import { ArrowLeft, Loader2, PackagePlus, RefreshCcw } from 'lucide-react'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import SettingsNotice from '../../settings/SettingsNotice'
import Field from '../../forms/field'
import { ApiError, jsonRequest, requestJson } from '../../../lib/http'
import { invalidateProviderCatalogCache } from '../../../hooks/useProviderCatalog'
import type { StepKind } from '../../../lib/plugin-catalog-types'

interface PluginManifest {
  id: string
  kind: string
  displayName: string
  version: string
}

interface PluginEntry {
  manifest: PluginManifest
  installed: boolean
  configured?: boolean
  source?: 'builtin' | 'dropin'
}

interface PluginsResponse {
  plugins: PluginEntry[]
}

const KIND_BY_STEP: Record<StepKind, string> = {
  llm: 'executor',
  scm: 'scm',
  tracker: 'tracker',
}

const STEP_LABEL: Record<StepKind, string> = {
  llm: 'LLM',
  scm: 'source-control',
  tracker: 'tracker',
}

interface CustomPluginDrawerProps {
  step: StepKind
  onClose: () => void
}

/**
 * In-modal drawer for installing drop-in plugins without leaving the
 * wizard. Lists discovered drop-ins for the current step's kind, plus
 * a manual "install from npm spec" form for plugins not yet on disk.
 * After install, the wizard restarts plugin discovery (via the
 * parent's reloadPlugins) — the user lands back on the step with the
 * new plugin available as a card.
 */
export default function CustomPluginDrawer({ step, onClose }: CustomPluginDrawerProps) {
  const kindWanted = KIND_BY_STEP[step]
  const [plugins, setPlugins] = useState<PluginEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [installSpec, setInstallSpec] = useState('')
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function loadPlugins() {
    setLoading(true)
    try {
      const data = await requestJson<PluginsResponse>('/plugins')
      setPlugins(data.plugins.filter(p => p.manifest.kind === kindWanted))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadPlugins()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindWanted])

  async function install(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setNotice(null)
    const spec = installSpec.trim()
    if (!spec) {
      setError('Enter an npm package name, e.g. `@coro-ai/plugin-gitlab`.')
      return
    }
    setInstalling(true)
    try {
      await requestJson<{ ok?: boolean }>(
        '/plugins/install',
        jsonRequest({ spec }, { method: 'POST' }),
      )
      setNotice(
        `Installed ${spec}. The plugin is live — pick it from the provider list to configure it.`,
      )
      setInstallSpec('')
      // The step behind this drawer renders from the provider catalog, which
      // is cached module-wide; without this the plugin the user just
      // installed is missing until a page reload.
      invalidateProviderCatalogCache()
      await loadPlugins()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
    }
  }

  const dropins = plugins.filter(p => p.source === 'dropin')
  const builtinsHint = plugins
    .filter(p => p.source === 'builtin')
    .map(p => p.manifest.displayName)
    .join(', ')

  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={onClose}
        className="inline-flex items-center gap-2 text-sm text-fg-muted hover:text-fg"
      >
        <ArrowLeft className="size-4" />
        Back to step
      </button>

      <div className="space-y-1.5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-subtle">
          Custom {STEP_LABEL[step]} plugins
        </div>
        <h2 className="text-balance text-xl font-semibold tracking-tight text-fg">
          Install something the built-ins don't cover
        </h2>
        <p className="max-w-2xl text-pretty text-sm text-fg-muted">
          Coro plugins are regular npm packages. Anything installed here shows up alongside the built-ins as a selectable option in the wizard.
        </p>
        {builtinsHint ? (
          <div className="text-[12px] text-fg-subtle">
            Built-in {STEP_LABEL[step]} options: {builtinsHint}.
          </div>
        ) : null}
      </div>

      {error ? <SettingsNotice tone="danger">{error}</SettingsNotice> : null}
      {notice ? <SettingsNotice tone="success">{notice}</SettingsNotice> : null}

      <form
        onSubmit={install}
        className="space-y-3 rounded-2xl border border-line bg-overlay/30 p-4"
      >
        <Field
          label="Install from npm"
          hint="The runner downloads the package into ~/.coro/plugins/ and registers it on next refresh."
        >
          <Input
            value={installSpec}
            onChange={event => setInstallSpec(event.target.value)}
            placeholder="@coro-ai/plugin-gitlab  (or any npm spec)"
            autoComplete="off"
            spellCheck={false}
            disabled={installing}
          />
        </Field>
        <div className="flex items-center justify-end gap-2">
          <Button type="submit" disabled={installing}>
            {installing ? (
              <>
                <Loader2 className="animate-spin" /> Installing…
              </>
            ) : (
              <>
                <PackagePlus />
                Install plugin
              </>
            )}
          </Button>
        </div>
      </form>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-fg">Already installed</div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void loadPlugins()}
            disabled={loading}
          >
            <RefreshCcw />
            Refresh
          </Button>
        </div>
        {loading ? (
          <div className="rounded-xl border border-line bg-overlay/30 px-3 py-4 text-sm text-fg-subtle">
            Loading…
          </div>
        ) : dropins.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line bg-overlay/20 px-3 py-4 text-sm text-fg-subtle">
            No drop-in plugins yet. Install one above to see it here.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {dropins.map(plugin => (
              <li
                key={plugin.manifest.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-line bg-overlay/30 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-fg">{plugin.manifest.displayName}</div>
                  <div className="truncate text-[12px] text-fg-subtle">
                    {plugin.manifest.id} · v{plugin.manifest.version}
                  </div>
                </div>
                <span className="rounded-full border border-line bg-overlay/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-fg-muted">
                  drop-in
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
