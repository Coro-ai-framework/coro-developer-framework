import { useState } from 'react'
import { GitBranch, Loader2 } from 'lucide-react'
import { Input } from '../../../components/ui/input'
import Field from '../../../components/forms/field'
import SettingsSection from '../../../components/settings/SettingsSection'
import SettingsNotice from '../../../components/settings/SettingsNotice'
import ChoiceGroup from '../../../components/settings/ChoiceGroup'
import SecretInput from '../../../components/settings/SecretInput'
import TestConnectionButton, {
  type TestConnectionResult,
} from '../../../components/settings/TestConnectionButton'
import { useSettings, type GitProvider } from '../SettingsContext'
import { ApiError, jsonRequest, requestJson } from '../../../lib/http'
import { evaluateReadiness } from '../readiness'

const GIT_OPTIONS = [
  { value: 'github' as const, label: 'GitHub', description: 'Built-in GitHub plugin (PRs, branches, reviews).' },
  { value: 'bitbucket' as const, label: 'Bitbucket', description: 'Built-in Bitbucket plugin (PRs, branches, reviews).' },
  { value: 'gitlab' as const, label: 'GitLab', description: 'Requires a GitLab drop-in plugin (not built in).' },
]

interface GitTestResponse {
  ok: boolean
  message?: string
}

export default function SourceControlSection() {
  const { draft, setDraft, claudeLogin, claudeLoginAccount } = useSettings()
  const readiness = evaluateReadiness({ draft, claudeLogin, claudeLoginAccount }).byId['source-control']
  const [_, setLastTest] = useState<TestConnectionResult | null>(null)

  const tokenLabel = draft.gitProvider === 'github' ? 'Personal access token' : 'App password'
  const workspaceLabel = draft.gitProvider === 'bitbucket' ? 'Workspace slug' : 'Organization / owner'
  const workspaceHint =
    draft.gitProvider === 'bitbucket'
      ? 'Required for the built-in Bitbucket plugin and PR APIs.'
      : draft.gitProvider === 'github'
        ? 'Required for the built-in GitHub plugin and repo/PR APIs.'
        : 'Used by GitLab drop-in plugins.'

  async function runTest(): Promise<TestConnectionResult> {
    try {
      const response = await requestJson<GitTestResponse>(
        '/test/git',
        jsonRequest(
          {
            provider: draft.gitProvider,
            username: draft.gitUsername,
            token: draft.gitToken,
            workspace: draft.gitWorkspace || undefined,
          },
          { method: 'POST' },
        ),
      )
      const next: TestConnectionResult = {
        ok: response.ok,
        message: response.message ?? (response.ok ? 'Authenticated.' : 'Connection failed.'),
      }
      setLastTest(next)
      return next
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message
      const next = { ok: false, message }
      setLastTest(next)
      return next
    }
  }

  return (
    <SettingsSection
      title="Source control"
      description="Credentials used for clone, branch, push, PR, and review operations on the host the runner runs jobs against."
      required
      status={readiness.status}
      statusLabel={readiness.label}
    >
      <Field label="Provider">
        <ChoiceGroup<GitProvider>
          name="git-provider"
          value={draft.gitProvider}
          onChange={value => setDraft('gitProvider', value)}
          options={GIT_OPTIONS}
          cols={3}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Username" hint="The account used to authenticate with the git provider.">
          <Input
            value={draft.gitUsername}
            onChange={event => setDraft('gitUsername', event.target.value)}
            placeholder="your-username"
            autoComplete="username"
          />
        </Field>
        <Field label={tokenLabel} hint="Stored in the local runner config file.">
          <SecretInput
            value={draft.gitToken}
            onChange={event => setDraft('gitToken', event.target.value)}
            placeholder={draft.gitProvider === 'github' ? 'ghp_…' : 'Token'}
          />
        </Field>
      </div>

      <Field label={workspaceLabel} hint={workspaceHint}>
        <Input
          value={draft.gitWorkspace}
          onChange={event => setDraft('gitWorkspace', event.target.value)}
          placeholder={draft.gitProvider === 'bitbucket' ? 'my-workspace' : 'my-org'}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <TestConnectionButton
          onTest={runTest}
          disabled={!draft.gitUsername || !draft.gitToken}
          label={
            <span className="inline-flex items-center gap-1.5">
              <GitBranch className="size-3.5" /> Test connection
            </span>
          }
        />
        <span className="text-xs text-fg-subtle">
          {readiness.detail}
        </span>
      </div>

      {draft.gitProvider === 'gitlab' ? (
        <SettingsNotice tone="warning">
          GitLab is not a built-in Coro plugin. Install a GitLab-compatible drop-in plugin from{' '}
          <strong>Extensions → Plugins</strong> before using GitLab for jobs.
        </SettingsNotice>
      ) : null}
    </SettingsSection>
  )
}

// Suppress unused warning while we keep the captured value for future inline display.
void Loader2
