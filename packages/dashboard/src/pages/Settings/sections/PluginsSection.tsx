import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react'
import { PackagePlus, Plug, RefreshCcw, Trash2 } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import Field from '../../../components/forms/field'
import SettingsSection from '../../../components/settings/SettingsSection'
import SettingsNotice from '../../../components/settings/SettingsNotice'
import { ApiError, jsonRequest, requestJson } from '../../../lib/http'
import { invalidateProviderCatalogCache } from '../../../hooks/useProviderCatalog'
import { cn } from '../../../lib/utils'
import { toneClasses, type Tone } from '../../../lib/status'

interface PluginManifestSummary {
  id: string
  kind: 'scm' | 'tracker' | string
  version: string
  displayName: string
  hostCompatibility: string
  capabilities?: Record<string, boolean>
  webhook?: { pathSuffix: string; algorithm: string; header: string; format: string }
  configSchema: unknown
}

interface PluginMcpServerSummary {
  type: 'stdio' | 'sse' | 'http' | string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

interface PluginsResponse {
  plugins: {
    manifest: PluginManifestSummary
    installed: boolean
    configured?: boolean
    active?: boolean
    available?: boolean
    activationHint?: string
    source?: 'builtin' | 'dropin'
    mcpServer?: PluginMcpServerSummary | null
  }[]
  defaults: { scm?: string; tracker?: string }
  webhookBaseUrl: string | null
}

type PluginEntry = PluginsResponse['plugins'][number]

function pluginConfigured(plugin: PluginEntry): boolean {
  return plugin.configured ?? plugin.installed
}

function pluginStatus(plugin: PluginEntry): { label: string; tone: Tone } {
  if (pluginConfigured(plugin) && plugin.active) return { label: 'enabled', tone: 'success' }
  if (pluginConfigured(plugin)) return { label: 'configured', tone: 'warning' }
  if (plugin.source === 'builtin') return { label: 'built in', tone: 'neutral' }
  return { label: 'installed', tone: 'neutral' }
}

function pluginSortValue(plugin: PluginEntry): number {
  if (pluginConfigured(plugin) && plugin.active) return 0
  if (pluginConfigured(plugin)) return 1
  if (plugin.source === 'builtin') return 2
  return 3
}

export default function PluginsSection() {
  const [pluginsState, setPluginsState] = useState<PluginsResponse | null>(null)
  const [pluginsLoading, setPluginsLoading] = useState(false)
  const [installSpec, setInstallSpec] = useState('')
  const [installId, setInstallId] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [installNotice, setInstallNotice] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)

  useEffect(() => {
    void loadPlugins()
  }, [])

  async function loadPlugins() {
    try {
      setPluginsLoading(true)
      const data = await requestJson<PluginsResponse>('/plugins')
      setPluginsState(data)
    } catch {
      setPluginsState(null)
    } finally {
      setPluginsLoading(false)
    }
  }

  async function installPlugin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setInstallError(null)
    setInstallNotice(null)
    const spec = installSpec.trim()
    if (!spec) {
      setInstallError('Enter an npm package name (e.g. `@coro-ai/plugin-gitlab`).')
      return
    }
    try {
      setInstalling(true)
      const body: Record<string, string> = { spec }
      const id = installId.trim()
      if (id) body['id'] = id
      const result = await requestJson<{
        manifest: { id: string; displayName: string }
        restartHint?: string
        reload?: { added: string[]; updated: string[] }
      }>(
        '/plugins/install',
        jsonRequest(body, { method: 'POST' }),
      )
      // The runner attempts a hot reload immediately. `restartHint` is
      // only present when the plugin can't be activated yet (e.g. no
      // config slot exists). Surface either the success message or the
      // hint, not both, so the toast is unambiguous.
      const wasLoaded = !result.restartHint
      setInstallNotice(
        wasLoaded
          ? `Installed "${result.manifest.displayName}" and loaded into the registry — no restart needed.`
          : `Installed "${result.manifest.displayName}". ${result.restartHint}`,
      )
      setInstallSpec('')
      setInstallId('')
      invalidateProviderCatalogCache()
      void loadPlugins()
    } catch (err) {
      setInstallError(err instanceof ApiError ? err.message : (err as Error).message)
    } finally {
      setInstalling(false)
    }
  }

  async function uninstallPlugin(id: string, displayName: string) {
    setInstallError(null)
    setInstallNotice(null)
    if (!window.confirm(`Remove drop-in plugin "${displayName}"? The runner will need a restart to drop it from memory.`)) {
      return
    }
    try {
      setRemovingId(id)
      const result = await requestJson<{ restartHint?: string }>(`/plugins/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      setInstallNotice(`Removed "${displayName}". ${result.restartHint ?? 'Restart the runner to fully unload it.'}`)
      invalidateProviderCatalogCache()
      void loadPlugins()
    } catch (err) {
      setInstallError(`Failed to uninstall ${displayName}: ${err instanceof ApiError ? err.message : (err as Error).message}`)
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Install a plugin"
        description="Drop-in plugins live under ~/.coro/plugins/. Paste any npm package name or git/tarball spec — the runner installs it locally and hot-loads it into the registry; configure credentials below to start using it."
      >
        <form onSubmit={installPlugin} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
            <Field
              label="npm spec"
              htmlFor="plugin-install-spec"
              hint="Examples: @coro-ai/plugin-gitlab, coro-plugin-jenkins@1.2.0, github:my-org/coro-plugin-acme."
            >
              <Input
                id="plugin-install-spec"
                value={installSpec}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setInstallSpec(e.target.value)}
                placeholder="@coro-ai/plugin-gitlab"
                disabled={installing}
              />
            </Field>
            <Field label="Plugin id (optional)" htmlFor="plugin-install-id">
              <Input
                id="plugin-install-id"
                value={installId}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setInstallId(e.target.value)}
                placeholder="gitlab"
                disabled={installing}
              />
            </Field>
            <Button type="submit" disabled={installing || !installSpec.trim()}>
              <PackagePlus />
              {installing ? 'Installing…' : 'Install'}
            </Button>
          </div>
          {installError ? <SettingsNotice tone="danger">{installError}</SettingsNotice> : null}
          {installNotice ? <SettingsNotice tone="success">{installNotice}</SettingsNotice> : null}
        </form>
      </SettingsSection>

      <SettingsSection
        title="Installed plugins"
        description="Provider integrations the runner has loaded. Each plugin contributes its own MCP tools, webhook normaliser, and (optionally) intelligence snippets."
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => void loadPlugins()} disabled={pluginsLoading}>
            <RefreshCcw />
            {pluginsLoading ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      >
        {pluginsState ? (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5">
                <div className="text-[11px] uppercase tracking-[0.16em] text-fg-subtle">Default SCM</div>
                <div className="mt-1 text-sm text-fg">{pluginsState.defaults.scm ?? '— (single enabled plugin wins)'}</div>
              </div>
              <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5">
                <div className="text-[11px] uppercase tracking-[0.16em] text-fg-subtle">Default tracker</div>
                <div className="mt-1 text-sm text-fg">{pluginsState.defaults.tracker ?? '— (single enabled plugin wins)'}</div>
              </div>
            </div>

            {pluginsState.plugins.some(plugin => pluginConfigured(plugin) && plugin.active) ? null : (
              <SettingsNotice tone="warning">
                No plugins are enabled yet. Coro ships with GitHub, Bitbucket, Jira, Linear, and GitHub Issues. Configure credentials under Source control / Issue tracker and restart the runner.
              </SettingsNotice>
            )}

            {pluginsState.plugins.length === 0 ? (
              <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-sm text-fg-muted">
                No plugins discovered.
              </div>
            ) : (
              <div className="space-y-3">
                {[...pluginsState.plugins]
                  .sort((left, right) => {
                    const bucket = pluginSortValue(left) - pluginSortValue(right)
                    if (bucket !== 0) return bucket
                    return left.manifest.displayName.localeCompare(right.manifest.displayName)
                  })
                  .map(plugin => {
                    const { manifest, source, mcpServer, activationHint } = plugin
                    const status = pluginStatus(plugin)
                    return (
                      <div key={manifest.id} className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <Plug className="size-4 text-fg-subtle" />
                              <div className="text-[15px] font-medium text-fg">{manifest.displayName}</div>
                              <span className="font-mono text-[11px] text-fg-subtle">{manifest.id}</span>
                              {source === 'dropin' ? (
                                <span className="rounded-full border border-line bg-overlay/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-fg-muted">
                                  drop-in
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 text-[12px] text-fg-muted">
                              kind: <span className="font-mono text-fg">{manifest.kind}</span>
                              {' · '}v{manifest.version}{' · '}host {manifest.hostCompatibility}
                            </div>
                            {!pluginConfigured(plugin) && activationHint ? (
                              <div className="mt-2 text-[12px] leading-5 text-fg-muted">{activationHint}</div>
                            ) : null}
                            {mcpServer ? (
                              <div className="mt-2 text-[11px] text-fg-muted">
                                Attached MCP server: <span className="font-mono">{mcpServer.type}</span>
                                {' · agents see tools as '}
                                <span className="font-mono">mcp__{manifest.id}__*</span>
                              </div>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                'rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em]',
                                toneClasses(status.tone),
                              )}
                            >
                              {status.label}
                            </span>
                            {source === 'dropin' ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => void uninstallPlugin(manifest.id, manifest.displayName)}
                                disabled={removingId === manifest.id}
                              >
                                <Trash2 />
                                {removingId === manifest.id ? 'Removing…' : 'Uninstall'}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    )
                  })}
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5 text-sm text-fg-muted">
            {pluginsLoading ? 'Loading plugins…' : 'Plugin discovery is unavailable. The runner may be too old or returned an error.'}
          </div>
        )}
      </SettingsSection>
    </div>
  )
}
