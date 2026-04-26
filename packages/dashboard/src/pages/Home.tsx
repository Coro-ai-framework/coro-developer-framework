import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate, Link } from 'react-router-dom'

// ── First-run detection ──────────────────────────────────────────────────────
//
// We hit GET /config (the same endpoint the Settings page uses) and decide
// whether the user has finished onboarding. Three states:
//
//   • loading        — request in flight; render nothing extra so we don't
//                      flash a misleading "you're not set up" banner.
//   • not-configured — `config === null` (no `~/.coro/config.json` yet).
//   • partial        — file exists but at least one essential field is
//                      empty. The Settings page can land in a half-set
//                      state if the user navigates away mid-flow.
//   • configured     — Anthropic auth + git creds present; banner hidden.

interface ConfigSnapshot {
  config: {
    anthropic?: { method?: string; apiKey?: string; oauthToken?: string }
    git?: { provider?: string; username?: string; token?: string }
    intelligence?: { dir?: string }
  } | null
}

type SetupState = 'loading' | 'not-configured' | 'partial' | 'configured'

interface SetupSummary {
  state: SetupState
  missing: string[]
}

function summariseConfig(snapshot: ConfigSnapshot | null): SetupSummary {
  if (snapshot === null) return { state: 'loading', missing: [] }
  if (snapshot.config === null) return { state: 'not-configured', missing: [] }

  const { anthropic, git } = snapshot.config
  const missing: string[] = []

  // The redacted shape from /config still includes the `method` tag and
  // empty / "" strings for absent secrets, so we can detect "no auth set"
  // without exposing the actual values to the dashboard.
  const hasAnthropicCreds =
    anthropic?.method === 'claudeLogin' ||
    Boolean(anthropic?.apiKey) ||
    Boolean(anthropic?.oauthToken)
  if (!hasAnthropicCreds) missing.push('Anthropic credentials')

  if (!git?.provider) missing.push('Git provider')
  if (!git?.username || !git?.token) missing.push('Git credentials')

  if (missing.length === 0) return { state: 'configured', missing }
  return { state: 'partial', missing }
}

export default function Home() {
  const [jobId, setJobId] = useState('')
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    fetch('/config')
      .then(r => (r.ok ? r.json() : Promise.resolve({ config: null })))
      .then((data: ConfigSnapshot) => {
        if (!cancelled) setSnapshot(data)
      })
      .catch(() => {
        if (!cancelled) setSnapshot({ config: null })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setup = summariseConfig(snapshot)

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = jobId.trim()
    if (trimmed) navigate(`/jobs/${trimmed}`)
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-56px)] px-4">
      <div className="w-full max-w-lg">
        {/* ── Welcome banner (only when setup is incomplete) ──────────── */}
        {(setup.state === 'not-configured' || setup.state === 'partial') && (
          <WelcomeBanner setup={setup} />
        )}

        {/* ── Branding + job lookup ─────────────────────────────────── */}
        <div className="text-center">
          <div className="w-12 h-12 rounded-xl bg-indigo-500 flex items-center justify-center text-white text-base font-bold mx-auto mb-5">
            Coro
          </div>
          <h1 className="text-2xl font-semibold text-white mb-1">Agent Job Viewer</h1>
          <p className="text-sm text-zinc-400 mb-8">
            Enter a job ID to view its live streaming logs.
          </p>

          <form onSubmit={handleSubmit} className="flex gap-2">
            <input
              type="text"
              value={jobId}
              onChange={e => setJobId(e.target.value)}
              placeholder="e.g. my-service-job-1712345678"
              autoFocus
              className="flex-1 px-4 py-2.5 rounded-lg bg-zinc-900 border border-zinc-700 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors font-mono"
            />
            <button
              type="submit"
              disabled={!jobId.trim()}
              className="px-5 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              View Logs
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}

function WelcomeBanner({ setup }: { setup: SetupSummary }) {
  const isFirstRun = setup.state === 'not-configured'
  const title = isFirstRun ? 'Welcome to Coro' : 'Finish setting up Coro'
  const body = isFirstRun
    ? 'No configuration found yet. Coro is the dashboard you\u2019re looking at — finish a one-time setup and you\u2019re ready to launch agent jobs.'
    : 'A few essentials are still missing before Coro can run jobs.'

  return (
    <div className="mb-8 rounded-xl border border-indigo-500/40 bg-indigo-500/10 p-5">
      <h2 className="text-base font-semibold text-indigo-100 mb-1">{title}</h2>
      <p className="text-sm text-indigo-200/90 mb-3">{body}</p>

      {setup.missing.length > 0 && (
        <ul className="text-sm text-indigo-200/80 mb-4 list-disc list-inside space-y-0.5">
          {setup.missing.map(m => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}

      <Link
        to="/settings"
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-400 transition-colors"
      >
        {isFirstRun ? 'Start setup \u2192' : 'Open Settings \u2192'}
      </Link>
    </div>
  )
}
