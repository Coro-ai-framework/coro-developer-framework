import { Input } from '../../../components/ui/input'
import Field from '../../../components/forms/field'
import SecretInput from '../../../components/settings/SecretInput'
import SettingsNotice from '../../../components/settings/SettingsNotice'
import SettingsSection from '../../../components/settings/SettingsSection'
import { useSettings } from '../SettingsContext'

/**
 * Where a retrospective may publish findings that belong to Coro itself.
 *
 * This is off until a repository URL is set, and that is deliberate: the
 * runner will open issues and pull requests under the operator's own
 * GitHub account, on a repository they do not control. Nothing here is
 * needed to run a retrospective against your own intelligence.
 */
export default function ContributionSection() {
  const { draft, setDraft, meta } = useSettings()

  const repoUrl = draft.upstreamRepoUrl.trim()
  // The runner's own view, which also accounts for the CORO_UPSTREAM_*
  // env vars. It lags the draft until the next save, so it answers "can
  // a retrospective publish right now", not "is this form filled in".
  const configured = meta?.resolved.upstreamConfigured ?? false

  return (
    <SettingsSection
      title="Coro contribution"
      description="Optional. Lets a retrospective report defects it finds in Coro itself back to the Coro repository, as issues and pull requests you own."
    >
      {!configured && !repoUrl ? (
        <SettingsNotice title="Contribution is off">
          Retrospectives still run and still propose improvements to your own
          intelligence. Without a repository below, findings about Coro itself
          are reported to you and go no further.
        </SettingsNotice>
      ) : null}

      <Field
        label="Coro repository"
        hint="The repository findings are contributed to. Leave blank to keep contribution off."
      >
        <Input
          type="url"
          inputMode="url"
          value={draft.upstreamRepoUrl}
          onChange={event => setDraft('upstreamRepoUrl', event.target.value)}
          placeholder="https://github.com/coro-ai-framework/coro"
        />
      </Field>

      <Field
        label="Fork owner"
        hint="GitHub account the runner pushes branches to. The fork is created for you on first use. Defaults to the owner configured on your GitHub plugin."
      >
        <Input
          value={draft.upstreamForkOwner}
          onChange={event => setDraft('upstreamForkOwner', event.target.value)}
          placeholder="your-github-username"
        />
      </Field>

      <Field
        label="GitHub token"
        hint="Needs the public_repo scope: fork, push, and open issues and pull requests. Defaults to your GitHub plugin's token."
      >
        <SecretInput
          value={draft.upstreamToken}
          onChange={event => setDraft('upstreamToken', event.target.value)}
          placeholder="ghp_…"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Issues per run" hint="Cap on issues one retrospective may open. Blank uses the default.">
          <Input
            type="number"
            min={0}
            value={draft.upstreamMaxIssuesPerRun}
            onChange={event => setDraft('upstreamMaxIssuesPerRun', event.target.value)}
            placeholder="5"
          />
        </Field>
        <Field
          label="Code runs per run"
          hint="Cap on implementation jobs one retrospective may dispatch to fix Coro's code. Blank uses the default."
        >
          <Input
            type="number"
            min={0}
            value={draft.upstreamMaxCodeJobsPerRun}
            onChange={event => setDraft('upstreamMaxCodeJobsPerRun', event.target.value)}
            placeholder="2"
          />
        </Field>
      </div>

      <SettingsNotice tone="accent" title="What still holds after you enable this">
        You choose per run how far findings may travel, and you approve each
        finding before anything is published. Repository names, ticket keys,
        and e-mail addresses are replaced with aliases, and any text still
        carrying a real one is refused rather than sent.
      </SettingsNotice>
    </SettingsSection>
  )
}
