// Declarative metadata for the FTUE wizard's pick-one-per-step UI.
//
// The Settings screen renders every plugin through its JSON Schema +
// `PluginConfigCard`. That works fine when a user is power-using
// every option, but it's overwhelming on first-time setup: too many
// fields, advanced toggles, alias editors. The wizard instead
// curates a small, opinionated shape — one provider card per
// built-in, the minimum fields required for the runner to clone /
// auth / dispatch, and a single "Test & Continue" CTA.
//
// Adding a new built-in provider for the wizard means appending an
// entry here. Drop-in plugins surface via the
// "Need something else?" drawer instead.

export type StepKind = 'llm' | 'scm' | 'tracker'

export type FieldKind = 'text' | 'secret' | 'url'

/**
 * A single form field rendered in the per-provider config block.
 * Keep this list short — anything power-user lives in Settings.
 */
export interface ProviderField {
  /** Plugin-config key (matches the runner's JSON Schema). */
  key: string
  /** Visible label. */
  label: string
  /** Short hint under the label (renders as muted text). */
  hint?: string
  /** Placeholder shown in the input. */
  placeholder?: string
  /** Field input type. `secret` renders the show/hide eye toggle. */
  kind: FieldKind
  /** When true, the field must be non-empty for "Test & Continue" to enable. */
  required?: boolean
}

/**
 * Discriminator for `ProviderEntry.authMode`. Controls which auth
 * surface the LLM step renders for this provider.
 *
 * - `apiKey`     — single API-key input + the standard "Test"
 *                  button. Used by OpenAI.
 * - `anthropic`  — bespoke surface that lets the user pick Claude
 *                  login (OAuth) or paste an API key. The Claude
 *                  login button is the recommended default.
 */
export type LlmAuthMode = 'apiKey' | 'anthropic'

export interface ProviderEntry {
  /** Plugin id used by the runner (matches `manifest.id`). */
  id: string
  /** Title shown on the provider card. */
  title: string
  /** One-line subtitle under the title. */
  subtitle: string
  /** When set, an "Recommended" pill renders on the card. */
  recommended?: boolean
  /** Step this provider belongs to. */
  step: StepKind
  /** Minimal form fields the wizard collects for this provider. */
  fields: ProviderField[]
  /**
   * Optional override of the auth surface (LLM step only). When
   * undefined, the field list above is rendered as a regular form.
   */
  authMode?: LlmAuthMode
}

/**
 * Provider catalog used by the FTUE wizard. Order = display order on
 * the picker cards.
 */
export const PROVIDER_CATALOG: ProviderEntry[] = [
  // ── LLM ────────────────────────────────────────────────────────────────
  {
    id: 'anthropic',
    title: 'Anthropic Claude',
    subtitle: 'Best results today. One-click sign-in with Claude login.',
    recommended: true,
    step: 'llm',
    fields: [],
    authMode: 'anthropic',
  },
  {
    id: 'openai',
    title: 'OpenAI',
    subtitle: 'GPT-4 / GPT-5 family via the OpenAI API.',
    step: 'llm',
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        kind: 'secret',
        placeholder: 'sk-…',
        hint: 'From platform.openai.com/api-keys.',
        required: true,
      },
      {
        key: 'baseURL',
        label: 'Base URL',
        kind: 'url',
        placeholder: 'https://api.openai.com/v1',
        hint: 'Optional. Override for Azure or self-hosted compatible endpoints.',
      },
    ],
    authMode: 'apiKey',
  },

  // ── SCM ────────────────────────────────────────────────────────────────
  {
    id: 'github',
    title: 'GitHub',
    subtitle: 'github.com or GitHub Enterprise. Personal or fine-grained PAT.',
    step: 'scm',
    fields: [
      {
        key: 'owner',
        label: 'Owner / organisation',
        kind: 'text',
        placeholder: 'acme-inc',
        hint: 'The org or user that owns the repos you want Coro to work in.',
        required: true,
      },
      {
        key: 'token',
        label: 'Personal access token',
        kind: 'secret',
        placeholder: 'ghp_… or github_pat_…',
        hint: "Needs the 'repo' scope (or equivalent fine-grained permissions).",
        required: true,
      },
    ],
  },
  {
    id: 'bitbucket',
    title: 'Bitbucket',
    subtitle: 'bitbucket.org workspaces. Atlassian API tokens.',
    step: 'scm',
    fields: [
      {
        key: 'workspace',
        label: 'Workspace',
        kind: 'text',
        placeholder: 'my-workspace',
        hint: 'The workspace slug from your Bitbucket URL.',
        required: true,
      },
      {
        key: 'coderUsername',
        label: 'Username or email',
        kind: 'text',
        placeholder: 'you@example.com',
        hint: 'Username for the agent account that will push commits.',
        required: true,
      },
      {
        key: 'coderToken',
        label: 'API token',
        kind: 'secret',
        placeholder: 'ATATT…',
        hint: 'Atlassian API token from id.atlassian.com/manage-profile/security/api-tokens.',
        required: true,
      },
    ],
  },

  // ── Tracker ────────────────────────────────────────────────────────────
  {
    id: 'jira',
    title: 'Jira',
    subtitle: 'Atlassian Cloud or Data Center. API token auth.',
    step: 'tracker',
    fields: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        kind: 'url',
        placeholder: 'https://acme.atlassian.net',
        required: true,
      },
      {
        key: 'username',
        label: 'Email',
        kind: 'text',
        placeholder: 'you@example.com',
        required: true,
      },
      {
        key: 'apiToken',
        label: 'API token',
        kind: 'secret',
        placeholder: 'ATATT…',
        required: true,
      },
    ],
  },
  {
    id: 'linear',
    title: 'Linear',
    subtitle: 'Linear API key. Fast issue tracker for product teams.',
    step: 'tracker',
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        kind: 'secret',
        placeholder: 'lin_api_…',
        hint: 'Generate in Linear → Settings → API → Personal API keys.',
        required: true,
      },
      {
        key: 'teamKey',
        label: 'Default team key',
        kind: 'text',
        placeholder: 'ENG',
        hint: "Optional. Picks the team Coro files issues against when a job doesn't specify one.",
      },
    ],
  },
  {
    id: 'github-issues',
    title: 'GitHub Issues',
    subtitle: 'Reuse your GitHub credentials to track work in repo issues.',
    step: 'tracker',
    fields: [
      {
        key: 'defaultOwner',
        label: 'Owner / organisation',
        kind: 'text',
        placeholder: 'acme-inc',
        required: true,
      },
      {
        key: 'token',
        label: 'Personal access token',
        kind: 'secret',
        placeholder: 'ghp_…',
        hint: "Needs the 'repo' scope. The same token used for source control works.",
        required: true,
      },
    ],
  },
]

export function getProvidersForStep(step: StepKind): ProviderEntry[] {
  return PROVIDER_CATALOG.filter(p => p.step === step)
}

export function getProvider(id: string): ProviderEntry | undefined {
  return PROVIDER_CATALOG.find(p => p.id === id)
}

/**
 * Map a draft provider config into the payload shape each `/test/*`
 * endpoint expects. Centralised here so the step components don't
 * have to know about endpoint contracts.
 */
export function buildTestPayload(
  step: StepKind,
  providerId: string,
  config: Record<string, unknown>,
): { url: string; body: Record<string, unknown> } | null {
  if (step === 'llm') {
    return {
      url: '/test/llm',
      body: { provider: providerId, config },
    }
  }
  if (step === 'scm') {
    if (providerId === 'github') {
      return {
        url: '/test/git',
        body: {
          provider: 'github',
          username: String(config['owner'] ?? ''),
          token: String(config['token'] ?? ''),
          workspace: String(config['owner'] ?? ''),
        },
      }
    }
    if (providerId === 'bitbucket') {
      return {
        url: '/test/git',
        body: {
          provider: 'bitbucket',
          username: String(config['coderUsername'] ?? ''),
          token: String(config['coderToken'] ?? ''),
          workspace: String(config['workspace'] ?? ''),
        },
      }
    }
    return null
  }
  if (step === 'tracker') {
    if (providerId === 'jira') {
      return {
        url: '/test/tracker',
        body: {
          provider: 'jira',
          jira: {
            baseUrl: String(config['baseUrl'] ?? ''),
            username: String(config['username'] ?? ''),
            apiToken: String(config['apiToken'] ?? ''),
          },
        },
      }
    }
    if (providerId === 'linear') {
      return {
        url: '/test/tracker',
        body: {
          provider: 'linear',
          linear: {
            apiKey: String(config['apiKey'] ?? ''),
            teamKey: String(config['teamKey'] ?? ''),
          },
        },
      }
    }
    if (providerId === 'github-issues') {
      return {
        url: '/test/tracker',
        body: {
          provider: 'github',
          git: {
            provider: 'github',
            username: String(config['defaultOwner'] ?? ''),
            token: String(config['token'] ?? ''),
            workspace: String(config['defaultOwner'] ?? ''),
          },
        },
      }
    }
  }
  return null
}
