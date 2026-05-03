import { useMemo, useState, type FormEvent, type ChangeEvent } from 'react'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import PageHeader from '../components/common/page-header'
import ErrorState from '../components/common/error-state'
import Field from '../components/forms/field'
import SectionCard from '../components/forms/section-card'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Select } from '../components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Textarea } from '../components/ui/textarea'
import { jsonRequest, requestJson } from '../lib/http'
import { IMPLEMENTATION_WORKFLOWS } from '../workflows'
import { cn } from '../lib/utils'

type GitProvider = 'bitbucket' | 'github'
type SourceMode = 'jira' | 'manual'

interface JobForm {
  repo: string
  serviceName: string
  description: string
  reviewers: string
  jiraTicketId: string
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
  const [mode, setMode] = useState<SourceMode>('manual')

  function handleJobChange(e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    setJobForm(prev => ({ ...prev, [e.target.name]: e.target.value }))
  }

  function handleModeChange(next: string) {
    const nextMode = next as SourceMode
    setMode(nextMode)
    setJobForm(previous =>
      nextMode === 'jira'
        ? { ...previous, jiraTicketId: previous.jiraTicketId || 'ENG-' }
        : { ...previous, jiraTicketId: '' },
    )
  }

  function splitCsv(val: string): string[] {
    return val.split(',').map(s => s.trim()).filter(Boolean)
  }

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

      const body = mode === 'jira'
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
        title="New run"
        description="Choose the workflow, source context, and operator mode."
        actions={
          <Button variant="outline" onClick={() => navigate('/jobs')}>
            <ArrowLeft />
            Back to runs
          </Button>
        }
      />

      <form onSubmit={handleSubmit} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <SectionCard
            title="Workflow"
            description={hasMultipleWorkflows ? 'Choose the workflow for this dispatch.' : undefined}
          >
            {hasMultipleWorkflows ? (
              <div className="grid gap-2">
                {IMPLEMENTATION_WORKFLOWS.map(item => {
                  const selected = item.workflowPath === workflowPath
                  return (
                    <label
                      key={item.id}
                      className={cn(
                        'cursor-pointer rounded-2xl border px-4 py-3.5 transition-colors',
                        selected
                          ? 'border-accent-500/35 bg-accent-500/8'
                          : 'border-line bg-overlay/40 hover:border-line-strong hover:bg-overlay/60',
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className={cn(
                            'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                            selected
                              ? 'border-accent-400 bg-accent-500 text-white'
                              : 'border-line-strong bg-overlay',
                          )}
                          aria-hidden
                        >
                          {selected ? <Check className="size-3" strokeWidth={3} /> : null}
                        </span>
                        <input
                          type="radio"
                          name="workflowPath"
                          value={item.workflowPath}
                          checked={selected}
                          onChange={() => setWorkflowPath(item.workflowPath)}
                          className="sr-only"
                        />
                        <div className="min-w-0">
                          <div className="text-[15px] font-medium text-fg">{item.name}</div>
                          <div className="mt-0.5 text-sm text-fg-muted">{item.description}</div>
                          <div className="mt-1 font-mono text-[11px] text-fg-subtle">
                            {item.workflowPath}
                          </div>
                        </div>
                      </div>
                    </label>
                  )
                })}
              </div>
            ) : workflow ? (
              <div className="rounded-2xl border border-line bg-overlay/40 px-4 py-3.5">
                <div className="text-[15px] font-medium text-fg">{workflow.name}</div>
                <div className="mt-0.5 text-sm text-fg-muted">{workflow.description}</div>
                <div className="mt-1 font-mono text-[11px] text-fg-subtle">{workflow.workflowPath}</div>
              </div>
            ) : null}
          </SectionCard>

          <SectionCard
            title="Source context"
            description="Use a tracker ticket or enter the run inputs directly."
          >
            <Tabs value={mode} onValueChange={handleModeChange} className="space-y-4">
              <TabsList>
                <TabsTrigger value="manual">Manual details</TabsTrigger>
                <TabsTrigger value="jira">Jira ticket</TabsTrigger>
              </TabsList>

              <TabsContent value="jira" className="space-y-4">
                <Field
                  label="Jira ticket ID"
                  required
                  hint="Tracker context overrides the manual fields."
                >
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
                  <Field label="Git provider" hint="Repository host.">
                    <Select
                      name="gitProvider"
                      value={jobForm.gitProvider}
                      onChange={handleJobChange}
                    >
                      <option value="bitbucket">Bitbucket</option>
                      <option value="github">GitHub</option>
                    </Select>
                  </Field>
                  <Field
                    label="Repository slug"
                    required
                    hint={jobForm.gitProvider === 'github' ? 'GitHub repository name.' : 'Bitbucket slug.'}
                  >
                    <Input
                      name="repo"
                      value={jobForm.repo}
                      onChange={handleJobChange}
                      required={mode === 'manual'}
                      placeholder="my-service"
                    />
                  </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Service name" required hint="Shown in the workbench.">
                    <Input
                      name="serviceName"
                      value={jobForm.serviceName}
                      onChange={handleJobChange}
                      required={mode === 'manual'}
                      placeholder="Billing API"
                    />
                  </Field>
                  <Field
                    label="Reviewers"
                    required
                    hint={
                      jobForm.gitProvider === 'github'
                        ? 'Comma-separated GitHub usernames.'
                        : 'Comma-separated Bitbucket usernames.'
                    }
                  >
                    <Input
                      name="reviewers"
                      value={jobForm.reviewers}
                      onChange={handleJobChange}
                      required={mode === 'manual'}
                      placeholder="alice, bob"
                    />
                  </Field>
                </div>

                <Field
                  label="Implementation description"
                  required
                  hint="Planner prompt. Keep it specific."
                >
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

          <SectionCard title="Run options" description="Choose whether the run pauses at checkpoints.">
            <label className="flex items-center justify-between gap-4 rounded-2xl border border-line bg-overlay/40 p-4">
              <div className="space-y-1">
                <div className="text-[15px] font-medium text-fg">Interactive mode</div>
                <p className="text-[12px] leading-5 text-fg-subtle">
                  Pause at interactive checkpoints for approval.
                </p>
              </div>
              <input
                type="checkbox"
                name="interactive"
                checked={interactive}
                onChange={event => setInteractive(event.target.checked)}
                className="size-4"
              />
            </label>
          </SectionCard>
        </div>

        <div className="space-y-4 xl:sticky xl:top-6 xl:self-start">
          <Card>
            <CardHeader className="border-b border-line pb-4">
              <CardTitle>Dispatch</CardTitle>
              <CardDescription>Final check before sending the run to the runner.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-5 text-sm">
              <SummaryRow label="Target" value={reviewSummary.title} />
              <SummaryRow label="Workflow" value={workflow?.name ?? '—'} />
              <SummaryRow label="Mode" value={mode === 'jira' ? 'Jira ticket' : 'Manual details'} />
              <SummaryRow label="Provider" value={jobForm.gitProvider === 'github' ? 'GitHub' : 'Bitbucket'} />
              <SummaryRow label="Interactive" value={interactive ? 'Yes' : 'No'} />

              <div className="rounded-xl border border-line bg-overlay/40 px-3 py-2.5 text-[12px] leading-5 text-fg-muted">
                {reviewSummary.description}
              </div>

              {error ? <ErrorState message={error} /> : null}

              <div className="flex flex-col gap-2 pt-1">
                <Button type="submit" size="lg" disabled={submitting}>
                  {submitting ? 'Dispatching…' : 'Dispatch run'}
                  <ArrowRight />
                </Button>
                <Button type="button" variant="ghost" onClick={() => navigate('/jobs')}>
                  Cancel
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </form>
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle">{label}</span>
      <span className="text-right text-fg">{value}</span>
    </div>
  )
}
