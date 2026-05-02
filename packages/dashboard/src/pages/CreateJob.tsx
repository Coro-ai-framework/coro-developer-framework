import { useMemo, useState, type FormEvent, type ChangeEvent } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/common/page-header'
import Field from '../components/forms/field'
import SectionCard from '../components/forms/section-card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Textarea } from '../components/ui/textarea'
import { jsonRequest, requestJson } from '../lib/http'
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

  const mode = jobForm.jiraTicketId.trim() ? 'jira' : 'manual'
  const workflow = IMPLEMENTATION_WORKFLOWS.find(item => item.workflowPath === workflowPath) ?? IMPLEMENTATION_WORKFLOWS[0]
  const hasMultipleWorkflows = IMPLEMENTATION_WORKFLOWS.length > 1

  const reviewSummary = useMemo(() => {
    if (mode === 'jira') {
      return {
        title: jobForm.jiraTicketId.trim() || 'Jira ticket required',
        description: 'Tracker-driven run',
      }
    }

    return {
      title: jobForm.serviceName.trim() || 'Service name required',
      description: jobForm.description.trim() || 'Manual run',
    }
  }, [jobForm.description, jobForm.jiraTicketId, jobForm.serviceName, mode])

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

      const data = await requestJson<{ jobId: string }>('/jobs', jsonRequest(body, { method: 'POST' }))
      navigate(`/jobs/${data.jobId}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Dispatch Workflow"
        title="Create Run"
        description="Choose the workflow, source context, and operator mode for the next run."
        actions={
          <Button variant="outline" onClick={() => navigate('/jobs')}>
            <ArrowLeft />
            Back to runs
          </Button>
        }
      />

      <form onSubmit={handleSubmit} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <SectionCard title="Workflow" description={hasMultipleWorkflows ? 'Choose the workflow for this dispatch.' : undefined}>
            {hasMultipleWorkflows ? (
              <div className="grid gap-3">
                {IMPLEMENTATION_WORKFLOWS.map(item => {
                  const selected = item.workflowPath === workflowPath
                  return (
                    <label
                      key={item.id}
                      className={`cursor-pointer rounded-2xl border px-4 py-4 transition-colors ${
                        selected
                          ? 'border-indigo-400/30 bg-indigo-500/10'
                          : 'border-white/8 bg-white/[0.03] hover:border-white/14 hover:bg-white/[0.05]'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <input
                          type="radio"
                          name="workflowPath"
                          value={item.workflowPath}
                          checked={selected}
                          onChange={() => setWorkflowPath(item.workflowPath)}
                          className="mt-1"
                        />
                        <div className="min-w-0">
                          <div className="text-base font-medium text-white">{item.name}</div>
                          <div className="mt-1 text-sm text-slate-500">{item.description}</div>
                          <div className="mt-2 font-mono text-xs text-slate-500">{item.workflowPath}</div>
                        </div>
                      </div>
                    </label>
                  )
                })}
              </div>
            ) : workflow ? (
              <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-4">
                <div className="text-base font-medium text-white">{workflow.name}</div>
                <div className="mt-1 text-sm text-slate-500">{workflow.description}</div>
                <div className="mt-2 font-mono text-xs text-slate-500">{workflow.workflowPath}</div>
              </div>
            ) : null}
          </SectionCard>

          <SectionCard title="Source Context" description="Use a tracker ticket or enter the run inputs directly.">
            <Tabs value={mode} className="space-y-4">
              <TabsList>
                <TabsTrigger value="jira" onClick={() => setJobForm(prev => ({ ...prev, jiraTicketId: prev.jiraTicketId || 'ENG-' }))}>Jira Ticket</TabsTrigger>
                <TabsTrigger value="manual" onClick={() => setJobForm(prev => ({ ...prev, jiraTicketId: '' }))}>Manual Details</TabsTrigger>
              </TabsList>

              <TabsContent value="jira" className="space-y-4">
                <Field label="Jira Ticket ID" required hint="Tracker context overrides the manual fields.">
                  <Input
                    name="jiraTicketId"
                    value={jobForm.jiraTicketId}
                    onChange={handleJobChange}
                    placeholder="ENG-1234"
                  />
                </Field>
              </TabsContent>

              <TabsContent value="manual" className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Git Provider" hint="Repository host.">
                    <Select name="gitProvider" value={jobForm.gitProvider} onChange={handleJobChange}>
                      <option value="bitbucket">BitBucket</option>
                      <option value="github">GitHub</option>
                    </Select>
                  </Field>
                  <Field label="Repository Slug" required hint={jobForm.gitProvider === 'github' ? 'GitHub repository name.' : 'BitBucket slug.'}>
                    <Input name="repo" value={jobForm.repo} onChange={handleJobChange} required={mode === 'manual'} placeholder="my-service" />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Service Name" required hint="Shown in the workbench.">
                    <Input name="serviceName" value={jobForm.serviceName} onChange={handleJobChange} required={mode === 'manual'} placeholder="Billing API" />
                  </Field>
                  <Field label="Reviewers" required hint={jobForm.gitProvider === 'github' ? 'Comma-separated GitHub usernames.' : 'Comma-separated BitBucket usernames.'}>
                    <Input name="reviewers" value={jobForm.reviewers} onChange={handleJobChange} required={mode === 'manual'} placeholder="alice, bob" />
                  </Field>
                </div>

                <Field label="Implementation Description" required hint="Planner prompt. Keep it specific.">
                  <Textarea
                    name="description"
                    value={jobForm.description}
                    onChange={handleJobChange}
                    required={mode === 'manual'}
                    rows={5}
                    placeholder="Add rate limiting to /api/users and return clear retry-after headers."
                  />
                </Field>
              </TabsContent>
            </Tabs>
          </SectionCard>

          <SectionCard title="Run Options" description="Choose whether the run pauses at checkpoints.">
            <label className="flex items-start justify-between gap-4 rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className="space-y-1.5">
                <div className="text-base font-medium text-white">Interactive mode</div>
                <p className="text-xs leading-5 text-slate-500">Pause at interactive checkpoints for approval.</p>
              </div>
              <input
                type="checkbox"
                name="interactive"
                checked={interactive}
                onChange={event => setInteractive(event.target.checked)}
                className="mt-1"
              />
            </label>
          </SectionCard>
        </div>

        <div className="space-y-6 xl:sticky xl:top-28 xl:self-start">
          <SectionCard title="Dispatch" description="Final check before sending the run to the runner.">
            <div className="space-y-4 text-sm">
              <div className="space-y-2 text-slate-400">
                <div className="flex items-center justify-between gap-4"><span>Target</span><span className="text-right text-slate-100">{reviewSummary.title}</span></div>
                <div className="flex items-center justify-between gap-4"><span>Workflow</span><span className="text-right text-slate-100">{workflow?.name ?? '—'}</span></div>
                <div className="flex items-center justify-between gap-4"><span>Mode</span><span className="text-right text-slate-100 capitalize">{mode}</span></div>
                <div className="flex items-center justify-between gap-4"><span>Provider</span><span className="text-right text-slate-100 capitalize">{jobForm.gitProvider}</span></div>
                <div className="flex items-center justify-between gap-4"><span>Interactive</span><span className="text-right text-slate-100">{interactive ? 'Yes' : 'No'}</span></div>
              </div>

              <div className="rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-xs leading-5 text-slate-500">
                {reviewSummary.description}
              </div>

              {error ? (
                <div className="rounded-2xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</div>
              ) : null}

              <div className="flex flex-col gap-2">
                <Button type="submit" size="lg" disabled={submitting}>
                  {submitting ? 'Dispatching…' : 'Dispatch run'}
                  <ArrowRight />
                </Button>
                <Button type="button" variant="ghost" onClick={() => navigate('/jobs')}>
                  Cancel
                </Button>
              </div>
            </div>
          </SectionCard>
        </div>
      </form>
    </div>
  )
}
