import { useState, type FormEvent, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'

type JobType = 'migration' | 'feature'

interface MigrateForm {
  repo: string
  serviceName: string
  projects: string        // comma-separated
  reviewers: string       // comma-separated
  stagingUrl: string
}

type GitProvider = 'bitbucket' | 'github'

interface FeatureForm {
  repo: string
  serviceName: string
  description: string
  reviewers: string       // comma-separated
  jiraTicketId: string    // optional Jira trigger (mutually exclusive with above)
  gitProvider: GitProvider
}

const EMPTY_MIGRATE: MigrateForm = {
  repo: '',
  serviceName: '',
  projects: '',
  reviewers: '',
  stagingUrl: '',
}

const EMPTY_FEATURE: FeatureForm = {
  repo: '',
  serviceName: '',
  description: '',
  reviewers: '',
  jiraTicketId: '',
  gitProvider: 'bitbucket',
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

export default function CreateJob() {
  const navigate = useNavigate()
  const [jobType, setJobType] = useState<JobType>('migration')
  const [migrate, setMigrate] = useState<MigrateForm>(EMPTY_MIGRATE)
  const [feature, setFeature] = useState<FeatureForm>(EMPTY_FEATURE)
  const [interactive, setInteractive] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleMigrateChange(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) {
    setMigrate(prev => ({ ...prev, [e.target.name]: e.target.value }))
  }

  function handleFeatureChange(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    setFeature(prev => ({ ...prev, [e.target.name]: e.target.value }))
  }

  function splitCsv(val: string): string[] {
    return val.split(',').map(s => s.trim()).filter(Boolean)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    try {
      let body: Record<string, unknown>
      let endpoint: string

      if (jobType === 'migration') {
        endpoint = '/jobs/migrate'
        body = {
          repo: migrate.repo.trim(),
          serviceName: migrate.serviceName.trim(),
          projects: splitCsv(migrate.projects),
          reviewers: splitCsv(migrate.reviewers),
          stagingUrl: migrate.stagingUrl.trim(),
          interactive,
        }
      } else {
        endpoint = '/jobs/feature'
        // Jira mode: only jiraTicketId required
        if (feature.jiraTicketId.trim()) {
          body = { jiraTicketId: feature.jiraTicketId.trim(), interactive }
        } else {
          body = {
            repo: feature.repo.trim(),
            serviceName: feature.serviceName.trim(),
            description: feature.description.trim(),
            reviewers: splitCsv(feature.reviewers),
            gitProvider: feature.gitProvider,
            interactive,
          }
        }
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`)
      }

      const data = await res.json() as { jobId: string }
      navigate(`/jobs/${data.jobId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  const isJiraMode = jobType === 'feature' && feature.jiraTicketId.trim().length > 0

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-white">New Job</h1>
        <p className="text-sm text-zinc-400 mt-1">Dispatch a migration or feature job to the agent runtime.</p>
      </div>

      {/* Workflow selector */}
      <div className="flex gap-2 mb-8">
        {(['migration', 'feature'] as JobType[]).map(t => (
          <button
            key={t}
            type="button"
            onClick={() => { setJobType(t); setError(null) }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors border ${
              jobType === t
                ? 'bg-indigo-600 border-indigo-500 text-white'
                : 'bg-zinc-900 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
            }`}
          >
            {t === 'migration' ? 'Migration' : 'Feature'}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {jobType === 'migration' && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass()}>Repository slug <span className="text-rose-400">*</span></label>
                <input
                  name="repo"
                  value={migrate.repo}
                  onChange={handleMigrateChange}
                  required
                  placeholder="my-service"
                  className={inputClass()}
                />
                <FieldHint>BitBucket repo slug (no org prefix)</FieldHint>
              </div>
              <div>
                <label className={labelClass()}>Service name <span className="text-rose-400">*</span></label>
                <input
                  name="serviceName"
                  value={migrate.serviceName}
                  onChange={handleMigrateChange}
                  required
                  placeholder="MyService"
                  className={inputClass()}
                />
              </div>
            </div>

            <div>
              <label className={labelClass()}>.NET projects <span className="text-rose-400">*</span></label>
              <input
                name="projects"
                value={migrate.projects}
                onChange={handleMigrateChange}
                required
                placeholder="MyService.API, MyService.Models"
                className={inputClass()}
              />
              <FieldHint>Comma-separated .csproj names to include in the migration</FieldHint>
            </div>

            <div>
              <label className={labelClass()}>Staging URL <span className="text-rose-400">*</span></label>
              <input
                name="stagingUrl"
                type="url"
                value={migrate.stagingUrl}
                onChange={handleMigrateChange}
                required
                placeholder="https://staging.my-service.a5labs.com"
                className={inputClass()}
              />
              <FieldHint>Base URL of the .NET staging service used for comparison testing</FieldHint>
            </div>

            <div>
              <label className={labelClass()}>Reviewers <span className="text-rose-400">*</span></label>
              <input
                name="reviewers"
                value={migrate.reviewers}
                onChange={handleMigrateChange}
                required
                placeholder="alice, bob"
                className={inputClass()}
              />
              <FieldHint>Comma-separated BitBucket usernames to add as PR reviewers</FieldHint>
            </div>
          </>
        )}

        {jobType === 'feature' && (
          <>
            {/* Jira shortcut */}
            <div className="rounded-lg border border-zinc-800 p-4 space-y-3 bg-zinc-900/40">
              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Option A — Jira ticket</p>
              <div>
                <label className={labelClass()}>Jira ticket ID</label>
                <input
                  name="jiraTicketId"
                  value={feature.jiraTicketId}
                  onChange={handleFeatureChange}
                  placeholder="ENG-1234"
                  className={inputClass()}
                />
                <FieldHint>If provided, the agent will fetch the spec from Jira. Fields below are ignored.</FieldHint>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex-1 h-px bg-zinc-800" />
              <span className="text-xs text-zinc-600 uppercase tracking-wider">or</span>
              <div className="flex-1 h-px bg-zinc-800" />
            </div>

            {/* Manual fields */}
            <div className={`space-y-5 transition-opacity ${isJiraMode ? 'opacity-30 pointer-events-none' : ''}`}>
              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider -mb-2">Option B — Manual</p>

              <div>
                <label className={labelClass()}>Git provider</label>
                <select
                  name="gitProvider"
                  value={feature.gitProvider}
                  onChange={handleFeatureChange}
                  className={inputClass()}
                >
                  <option value="bitbucket">BitBucket</option>
                  <option value="github">GitHub</option>
                </select>
                <FieldHint>Where the repository is hosted</FieldHint>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelClass()}>Repository slug {!isJiraMode && <span className="text-rose-400">*</span>}</label>
                  <input
                    name="repo"
                    value={feature.repo}
                    onChange={handleFeatureChange}
                    required={!isJiraMode}
                    placeholder="my-service-go"
                    className={inputClass()}
                  />
                  <FieldHint>{feature.gitProvider === 'github' ? 'GitHub repo name' : 'BitBucket repo slug'}</FieldHint>
                </div>
                <div>
                  <label className={labelClass()}>Service name {!isJiraMode && <span className="text-rose-400">*</span>}</label>
                  <input
                    name="serviceName"
                    value={feature.serviceName}
                    onChange={handleFeatureChange}
                    required={!isJiraMode}
                    placeholder="MyService"
                    className={inputClass()}
                  />
                </div>
              </div>

              <div>
                <label className={labelClass()}>Description {!isJiraMode && <span className="text-rose-400">*</span>}</label>
                <textarea
                  name="description"
                  value={feature.description}
                  onChange={handleFeatureChange}
                  required={!isJiraMode}
                  rows={3}
                  placeholder="Add rate limiting to /api/users"
                  className={`${inputClass()} resize-none`}
                />
              </div>

              <div>
                <label className={labelClass()}>Reviewers {!isJiraMode && <span className="text-rose-400">*</span>}</label>
                <input
                  name="reviewers"
                  value={feature.reviewers}
                  onChange={handleFeatureChange}
                  required={!isJiraMode}
                  placeholder="alice, bob"
                  className={inputClass()}
                />
                <FieldHint>{feature.gitProvider === 'github' ? 'Comma-separated GitHub usernames' : 'Comma-separated BitBucket usernames'}</FieldHint>
              </div>
            </div>
          </>
        )}

        {/* Interactive mode toggle — shared by both workflows */}
        <div className="rounded-lg border border-zinc-800 p-4 bg-zinc-900/40">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              name="interactive"
              checked={interactive}
              onChange={e => setInteractive(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-900 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0"
            />
            <div>
              <div className="text-sm font-medium text-zinc-200">Interactive mode</div>
              <div className="text-xs text-zinc-500 mt-0.5">
                Pause for my approval between phases. The job will park after each interactive
                checkpoint and wait until I either approve it or send a message asking for changes.
              </div>
            </div>
          </label>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-rose-950/30 border border-rose-800 text-rose-300 text-sm">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={() => navigate('/jobs')}
            className="text-sm text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? 'Dispatching…' : 'Dispatch job'}
          </button>
        </div>
      </form>
    </div>
  )
}
