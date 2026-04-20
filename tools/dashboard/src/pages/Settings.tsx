import { useState, useEffect, type FormEvent, type ChangeEvent } from 'react'

interface ConfigResponse {
  config: {
    anthropic?: { apiKey: string }
    intelligence?: { dir: string; gitRemote?: string }
    paths?: { workingDir: string }
    git?: {
      provider: 'bitbucket' | 'github' | 'gitlab'
      username: string
      token: string
      workspace?: string
    }
    cloud?: { url: string; token: string }
  } | null
  configPath: string
  mode: 'hybrid' | 'local' | 'legacy'
  resolved: {
    intelligenceDir: string
    workingDir: string
  } | null
}

interface SettingsForm {
  apiKey: string
  intelligenceDir: string
  intelligenceRemote: string
  workingDir: string
  gitProvider: 'bitbucket' | 'github' | 'gitlab'
  gitUsername: string
  gitToken: string
  gitWorkspace: string
}

const EMPTY_FORM: SettingsForm = {
  apiKey: '',
  intelligenceDir: '',
  intelligenceRemote: '',
  workingDir: '',
  gitProvider: 'github',
  gitUsername: '',
  gitToken: '',
  gitWorkspace: '',
}

function labelClass() {
  return 'block text-xs font-medium text-zinc-400 mb-1'
}

function inputClass() {
  return 'w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors'
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-zinc-500">{children}</p>
}

export default function Settings() {
  const [form, setForm] = useState<SettingsForm>(EMPTY_FORM)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [meta, setMeta] = useState<{ configPath: string; mode: string; resolved: ConfigResponse['resolved'] } | null>(null)

  useEffect(() => {
    loadConfig()
  }, [])

  async function loadConfig() {
    try {
      setLoading(true)
      const res = await fetch('/config')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as ConfigResponse

      setMeta({ configPath: data.configPath, mode: data.mode, resolved: data.resolved })

      if (data.config) {
        setForm({
          apiKey: data.config.anthropic?.apiKey ?? '',
          intelligenceDir: data.config.intelligence?.dir ?? '',
          intelligenceRemote: data.config.intelligence?.gitRemote ?? '',
          workingDir: data.config.paths?.workingDir ?? '',
          gitProvider: data.config.git?.provider ?? 'github',
          gitUsername: data.config.git?.username ?? '',
          gitToken: data.config.git?.token ?? '',
          gitWorkspace: data.config.git?.workspace ?? '',
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  function handleChange(e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }))
    setSuccess(null)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    setSaving(true)

    try {
      const body: Record<string, unknown> = {
        anthropic: { apiKey: form.apiKey },
        intelligence: {
          dir: form.intelligenceDir || undefined,
          gitRemote: form.intelligenceRemote || undefined,
        },
        paths: { workingDir: form.workingDir || undefined },
        git: form.gitUsername ? {
          provider: form.gitProvider,
          username: form.gitUsername,
          token: form.gitToken,
          workspace: form.gitWorkspace || undefined,
        } : undefined,
      }

      const res = await fetch('/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
      }

      setSuccess('Configuration saved. Restart the runner for changes to take effect.')
      await loadConfig() // Reload to get resolved paths
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="text-zinc-400 text-sm">Loading configuration...</div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-white">Settings</h1>
        <p className="text-sm text-zinc-400 mt-1">Configure the A5 runner. Changes are saved to the local config file.</p>
      </div>

      {/* Status banner */}
      {meta && (
        <div className="mb-6 p-4 rounded-lg bg-zinc-900 border border-zinc-800 space-y-2">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-zinc-500 uppercase tracking-wide">Mode</span>
            <span className={`px-2 py-0.5 rounded text-xs font-semibold ${
              meta.mode === 'local'
                ? 'bg-emerald-900/50 text-emerald-400 border border-emerald-800'
                : meta.mode === 'hybrid'
                ? 'bg-indigo-900/50 text-indigo-400 border border-indigo-800'
                : 'bg-amber-900/50 text-amber-400 border border-amber-800'
            }`}>
              {meta.mode}
            </span>
          </div>
          <div className="text-xs text-zinc-500">
            Config: <span className="text-zinc-400 font-mono">{meta.configPath}</span>
          </div>
          {meta.resolved && (
            <>
              <div className="text-xs text-zinc-500">
                Intelligence: <span className="text-zinc-400 font-mono">{meta.resolved.intelligenceDir}</span>
              </div>
              <div className="text-xs text-zinc-500">
                Working dir: <span className="text-zinc-400 font-mono">{meta.resolved.workingDir}</span>
              </div>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="mb-6 p-3 rounded-lg bg-rose-950/50 border border-rose-900 text-sm text-rose-300">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-6 p-3 rounded-lg bg-emerald-950/50 border border-emerald-900 text-sm text-emerald-300">
          {success}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-8">

        {/* ── Anthropic ── */}
        <section>
          <h2 className="text-sm font-semibold text-zinc-300 mb-4 pb-2 border-b border-zinc-800">Anthropic</h2>
          <div>
            <label className={labelClass()}>API Key <span className="text-rose-400">*</span></label>
            <input
              name="apiKey"
              type="password"
              value={form.apiKey}
              onChange={handleChange}
              placeholder="sk-ant-..."
              className={inputClass()}
            />
            <FieldHint>Your Anthropic API key for running agent phases</FieldHint>
          </div>
        </section>

        {/* ── Git Provider ── */}
        <section>
          <h2 className="text-sm font-semibold text-zinc-300 mb-4 pb-2 border-b border-zinc-800">Git Provider</h2>
          <div className="space-y-4">
            <div>
              <label className={labelClass()}>Provider</label>
              <select
                name="gitProvider"
                value={form.gitProvider}
                onChange={handleChange}
                className={inputClass()}
              >
                <option value="github">GitHub</option>
                <option value="bitbucket">BitBucket</option>
                <option value="gitlab">GitLab</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass()}>Username</label>
                <input
                  name="gitUsername"
                  value={form.gitUsername}
                  onChange={handleChange}
                  placeholder="your-username"
                  className={inputClass()}
                />
              </div>
              <div>
                <label className={labelClass()}>
                  {form.gitProvider === 'github' ? 'Personal Access Token' : 'App Password'}
                </label>
                <input
                  name="gitToken"
                  type="password"
                  value={form.gitToken}
                  onChange={handleChange}
                  placeholder={form.gitProvider === 'github' ? 'ghp_...' : 'Token'}
                  className={inputClass()}
                />
              </div>
            </div>
            <div>
              <label className={labelClass()}>
                {form.gitProvider === 'bitbucket' ? 'Workspace slug' : 'Organization / Owner'}
              </label>
              <input
                name="gitWorkspace"
                value={form.gitWorkspace}
                onChange={handleChange}
                placeholder={form.gitProvider === 'bitbucket' ? 'my-workspace' : 'my-org'}
                className={inputClass()}
              />
            </div>
          </div>
        </section>

        {/* ── Paths ── */}
        <section>
          <h2 className="text-sm font-semibold text-zinc-300 mb-4 pb-2 border-b border-zinc-800">Paths</h2>
          <div className="space-y-4">
            <div>
              <label className={labelClass()}>Intelligence directory</label>
              <input
                name="intelligenceDir"
                value={form.intelligenceDir}
                onChange={handleChange}
                placeholder="~/.a5/intelligence"
                className={inputClass()}
              />
              <FieldHint>Directory containing agents/, workflows/, skills/, and memory/ (the a5-ai repo)</FieldHint>
            </div>
            <div>
              <label className={labelClass()}>Intelligence git remote</label>
              <input
                name="intelligenceRemote"
                value={form.intelligenceRemote}
                onChange={handleChange}
                placeholder="https://github.com/org/a5-ai.git (optional)"
                className={inputClass()}
              />
              <FieldHint>Git remote to pull intelligence updates from</FieldHint>
            </div>
            <div>
              <label className={labelClass()}>Working directory</label>
              <input
                name="workingDir"
                value={form.workingDir}
                onChange={handleChange}
                placeholder="~/.a5/working"
                className={inputClass()}
              />
              <FieldHint>Directory where repos are cloned during job execution</FieldHint>
            </div>
          </div>
        </section>

        {/* ── Submit ── */}
        <div className="pt-4 border-t border-zinc-800">
          <button
            type="submit"
            disabled={saving}
            className="px-5 py-2.5 rounded-lg bg-indigo-600 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      </form>
    </div>
  )
}
