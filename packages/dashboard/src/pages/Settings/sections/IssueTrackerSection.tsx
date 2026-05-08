import { Input } from '../../../components/ui/input'
import Field from '../../../components/forms/field'
import SettingsSection from '../../../components/settings/SettingsSection'
import SettingsNotice from '../../../components/settings/SettingsNotice'
import ChoiceGroup from '../../../components/settings/ChoiceGroup'
import SecretInput from '../../../components/settings/SecretInput'
import TestConnectionButton, {
  type TestConnectionResult,
} from '../../../components/settings/TestConnectionButton'
import { useSettings, type TrackerProvider } from '../SettingsContext'
import { ApiError, jsonRequest, requestJson } from '../../../lib/http'
import { evaluateReadiness } from '../readiness'

const TRACKER_OPTIONS = [
  { value: 'none' as const, label: 'None', description: 'Run campaigns without tracker round-trips.' },
  { value: 'jira' as const, label: 'Jira', description: 'Create issues through Jira Cloud or Server.' },
  { value: 'github' as const, label: 'GitHub Issues', description: 'Reuse the GitHub credentials from Source control.' },
  { value: 'linear' as const, label: 'Linear', description: 'Create issues through Linear.' },
]

interface TrackerTestResponse {
  ok: boolean
  message?: string
}

export default function IssueTrackerSection() {
  const { draft, setDraft, claudeLogin, claudeLoginAccount } = useSettings()
  const readiness = evaluateReadiness({ draft, claudeLogin, claudeLoginAccount }).byId['issue-tracker']

  async function runTest(): Promise<TestConnectionResult> {
    try {
      const payload =
        draft.trackerProvider === 'jira'
          ? {
              provider: 'jira' as const,
              jira: {
                baseUrl: draft.jiraBaseUrl,
                username: draft.jiraUsername,
                apiToken: draft.jiraApiToken,
              },
            }
          : draft.trackerProvider === 'linear'
            ? {
                provider: 'linear' as const,
                linear: { apiKey: draft.linearApiKey, teamKey: draft.linearTeamKey },
              }
            : draft.trackerProvider === 'github'
              ? {
                  provider: 'github' as const,
                  git: {
                    provider: draft.gitProvider,
                    username: draft.gitUsername,
                    token: draft.gitToken,
                    workspace: draft.gitWorkspace,
                  },
                }
              : { provider: 'none' as const }
      const response = await requestJson<TrackerTestResponse>(
        '/test/tracker',
        jsonRequest(payload, { method: 'POST' }),
      )
      return {
        ok: response.ok,
        message: response.message ?? (response.ok ? 'Connected.' : 'Connection failed.'),
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message
      return { ok: false, message }
    }
  }

  return (
    <SettingsSection
      title="Issue tracker"
      description="Used by campaign workflows when they need to file an epic and child issues. Optional for one-off jobs."
      status={readiness.status}
      statusLabel={readiness.status === 'optional' ? 'Optional' : readiness.label}
    >
      <Field label="Provider">
        <ChoiceGroup<TrackerProvider>
          name="tracker-provider"
          value={draft.trackerProvider}
          onChange={value => setDraft('trackerProvider', value)}
          options={TRACKER_OPTIONS}
          cols={4}
        />
      </Field>

      {draft.trackerProvider === 'jira' ? (
        <div className="grid gap-4 rounded-2xl border border-line bg-overlay/40 p-4">
          <Field label="Base URL" required hint="Your Jira Cloud or Server site, including protocol.">
            <Input
              value={draft.jiraBaseUrl}
              onChange={event => setDraft('jiraBaseUrl', event.target.value)}
              placeholder="https://your-org.atlassian.net"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Username (email)" required>
              <Input
                value={draft.jiraUsername}
                onChange={event => setDraft('jiraUsername', event.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
              />
            </Field>
            <Field label="API token" required>
              <SecretInput
                value={draft.jiraApiToken}
                onChange={event => setDraft('jiraApiToken', event.target.value)}
                placeholder="Atlassian API token"
              />
            </Field>
          </div>
        </div>
      ) : null}

      {draft.trackerProvider === 'github' ? (
        <SettingsNotice tone={draft.gitProvider === 'github' && draft.gitToken ? 'success' : 'warning'}>
          {draft.gitProvider === 'github' && draft.gitToken
            ? `GitHub Issues will reuse the configured GitHub token for ${draft.gitWorkspace || 'the current owner'}. Ensure it includes repo + issues write scopes.`
            : 'Set the source control provider to GitHub and fill in a token + organization. The tracker reuses those credentials.'}
        </SettingsNotice>
      ) : null}

      {draft.trackerProvider === 'linear' ? (
        <div className="grid gap-4 rounded-2xl border border-line bg-overlay/40 p-4">
          <Field label="API key" required hint="Personal API key from linear.app/settings/api.">
            <SecretInput
              value={draft.linearApiKey}
              onChange={event => setDraft('linearApiKey', event.target.value)}
              placeholder="lin_api_…"
            />
          </Field>
          <Field
            label="Default team key"
            hint="Used when the campaign planner does not override the target team."
          >
            <Input
              value={draft.linearTeamKey}
              onChange={event => setDraft('linearTeamKey', event.target.value)}
              placeholder="ENG"
            />
          </Field>
        </div>
      ) : null}

      {draft.trackerProvider !== 'none' ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <TestConnectionButton onTest={runTest} />
          <span className="text-xs text-fg-subtle">{readiness.detail}</span>
        </div>
      ) : null}
    </SettingsSection>
  )
}
