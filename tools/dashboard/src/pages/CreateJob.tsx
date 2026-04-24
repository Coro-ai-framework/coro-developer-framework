import { useState, type FormEvent, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { IMPLEMENTATION_WORKFLOWS } from '../workflows'

type GitProvider = 'bitbucket' | 'github'

interface JobForm {
  repo: string
  serviceName: string
  description: string
  reviewers: string       // comma-separated
  jiraTicketId: string    // optional Jira trigger (mutually exclusive with above)
  gitProvider: GitProvider
}

const EMPTY_JOB: JobForm = {
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
  const [jobForm, setJobForm] = useState<JobForm>(EMPTY_JOB)
  const [workflowPath, setWorkflowPath] = useState<string>(IMPLEMENTATION_WORKFLOWS[0]?.workflowPath ?? '')
  const [interactive, setInteractive] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleJobChange(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    setJobForm(prev => ({ ...prev, [e.target.name]: e.target.value }))
  }

  function splitCsv(val: string): string[] {
    return val.split(',').map(s => s.trim()).filter(Boolean)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    try {
      if (!workflowPath) {
        throw new Error('Select a workflow before dispatching the job')
      }

      const body = jobForm.jiraTicketId.trim()
        ? {
            type: 'job',
            workflowPath,
            jiraTicketId: jobForm.jiraTicketId.trim(),
            interactive,
          }
        : {
            type: 'job',
            workflowPath,
            repo: jobForm.repo.trim(),
            serviceName: jobForm.serviceName.trim(),
            description: jobForm.description.trim(),
            reviewers: splitCsv(jobForm.reviewers),
            gitProvider: jobForm.gitProvider,
            interactive,
          }

      const res = await fetch('/jobs', {
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

  const isJiraMode = jobForm.jiraTicketId.trim().length > 0

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-white">New Implementation</h1>
        <p className="text-sm text-zinc-400 mt-1">Select a workflow, then dispatch an implementation job to the agent runtime.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="mb-3">
            <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Workflow</h2>
            <p className="text-sm text-zinc-500 mt-1">This list is static for now. The selected workflow path is sent with the job request.</p>
          </div>

          <div className="space-y-3">
            {IMPLEMENTATION_WORKFLOWS.map(workflow => {
              const selected = workflow.workflowPath === workflowPath

              return (
                <label
                  key={workflow.id}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
                    selected
                      ? 'border-indigo-500 bg-indigo-950/30'
                      : 'border-zinc-800 bg-zinc-950/60 hover:border-zinc-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="workflowPath"
                    value={workflow.workflowPath}
                    checked={selected}
                    onChange={() => setWorkflowPath(workflow.workflowPath)}
                    className="mt-1 h-4 w-4 border-zinc-600 bg-zinc-900 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-zinc-100">{workflow.name}</div>
                    <div className="mt-1 text-sm text-zinc-400">{workflow.description}</div>
                    <div className="mt-2 text-[11px] font-mono text-zinc-500">{workflow.workflowPath}</div>
                  </div>
                </label>
              )
            })}
          </div>
        </div>

        <>
          <div className="rounded-lg border border-zinc-800 p-4 space-y-3 bg-zinc-900/40">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Option A — Jira ticket</p>
            <div>
              <label className={labelClass()}>Jira ticket ID</label>
              <input
                name="jiraTicketId"
                value={jobForm.jiraTicketId}
                onChange={handleJobChange}
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

          <div className={`space-y-5 transition-opacity ${isJiraMode ? 'opacity-30 pointer-events-none' : ''}`}>
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider -mb-2">Option B — Manual</p>

            <div>
              <label className={labelClass()}>Git provider</label>
              <select
                name="gitProvider"
                value={jobForm.gitProvider}
                onChange={handleJobChange}
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
                  value={jobForm.repo}
                  onChange={handleJobChange}
                  required={!isJiraMode}
                  placeholder="my-service"
                  className={inputClass()}
                />
                <FieldHint>{jobForm.gitProvider === 'github' ? 'GitHub repo name' : 'BitBucket repo slug'}</FieldHint>
              </div>
              <div>
                <label className={labelClass()}>Service name {!isJiraMode && <span className="text-rose-400">*</span>}</label>
                <input
                  name="serviceName"
                  value={jobForm.serviceName}
                  onChange={handleJobChange}
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
                value={jobForm.description}
                onChange={handleJobChange}
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
                value={jobForm.reviewers}
                onChange={handleJobChange}
                required={!isJiraMode}
                placeholder="alice, bob"
                className={inputClass()}
              />
              <FieldHint>{jobForm.gitProvider === 'github' ? 'Comma-separated GitHub usernames' : 'Comma-separated BitBucket usernames'}</FieldHint>
            </div>
          </div>
        </>
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
