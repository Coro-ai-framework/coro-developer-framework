export type StepKind = 'llm' | 'scm' | 'tracker'

export type PluginAuthFieldKind = 'text' | 'secret' | 'url'

export interface PluginAuthFieldDescriptor {
  key: string
  label: string
  hint?: string
  placeholder?: string
  kind: PluginAuthFieldKind
  required?: boolean
}

export type PluginAuthMethodDescriptor =
  | {
      kind: 'oauth'
      id: string
      label: string
      recommended?: boolean
      startPath: string
      statusPath: string
      configOnSelect?: Record<string, unknown>
      successAccountPath?: string
      clientIdConfigKey?: string
    }
  | {
      kind: 'detect'
      id: string
      label: string
      recommended?: boolean
      accountConfigKey?: string
    }
  | {
      kind: 'form'
      id: string
      label: string
      recommended?: boolean
      fields: PluginAuthFieldDescriptor[]
      configOnSelect?: Record<string, unknown>
    }

export interface PluginRepoRefDescriptor {
  /** `slug` is `owner/repo`; `path` is an absolute filesystem path. */
  kind: 'slug' | 'path'
  label?: string
  hint?: string
  placeholder?: string
}

export interface PluginCatalogEntry {
  id: string
  kind: string
  displayName: string
  ui?: {
    customPanel?: string
    subtitle?: string
    recommendedForOnboarding?: boolean
    /**
     * How the active provider names a repository. Lets the Create Job form
     * ask for a path or a slug without hardcoding which provider is which.
     */
    repoRef?: PluginRepoRefDescriptor
  }
  capabilities: Record<string, boolean>
  authMethods: ReadonlyArray<PluginAuthMethodDescriptor>
  configSchema: unknown
}

export interface DetectCandidatePreview {
  id: string
  sourceLabel: string
  accountHint?: string
  preview: Array<{ label: string; value: string }>
}

export type NormalizedOAuthStatus = {
  state: 'idle' | 'pending' | 'success' | 'error'
  authorizeUrl?: string
  userCode?: string
  account?: { label: string }
  message?: string
  /**
   * Machine-readable reason. `setup_required` means the user must do
   * something outside Coro first (install a CLI, register an app) — render
   * it as guidance, not a failure. Replaces pattern-matching on `message`.
   */
  code?: 'setup_required'
  /** False when this flow cannot run on this machine as configured. */
  available?: boolean
  setupHint?: string
  callbackUrl?: string
}

export function kindForStep(step: StepKind): string {
  if (step === 'llm') return 'executor'
  return step
}

export function pickDefaultAuthMethod(
  methods: ReadonlyArray<PluginAuthMethodDescriptor>,
): PluginAuthMethodDescriptor | undefined {
  return methods.find(m => m.recommended) ?? methods[0]
}

export function activeFormFields(
  method: PluginAuthMethodDescriptor | undefined,
): PluginAuthFieldDescriptor[] {
  if (!method || method.kind !== 'form') return []
  return [...method.fields]
}

// ── Repository reference ─────────────────────────────────────────────────────

/**
 * What to ask for when a provider declares nothing. Hosted providers all
 * identify repositories by slug, so this is the safe default and no manifest
 * needs to restate it.
 */
const DEFAULT_REPO_REF: Required<PluginRepoRefDescriptor> = {
  kind: 'slug',
  label: 'Repository',
  hint: 'owner/repo or workspace/repo, depending on your provider.',
  placeholder: 'my-org/billing-api',
}

/** Merge a provider's repo-reference hints over the defaults. */
export function resolveRepoRef(
  entry: PluginCatalogEntry | undefined,
): Required<PluginRepoRefDescriptor> {
  const declared = entry?.ui?.repoRef
  if (!declared) return DEFAULT_REPO_REF
  return {
    kind: declared.kind,
    label: declared.label ?? DEFAULT_REPO_REF.label,
    hint: declared.hint ?? DEFAULT_REPO_REF.hint,
    placeholder: declared.placeholder ?? DEFAULT_REPO_REF.placeholder,
  }
}

/**
 * Client-side check that the typed value is the shape the active provider
 * expects. Returns a message to show, or null when it looks right. Kept
 * deliberately loose — this is a typo catcher, not authorisation.
 */
export function validateRepoRef(
  ref: Pick<PluginRepoRefDescriptor, 'kind'>,
  value: string,
): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (ref.kind === 'path') {
    if (!trimmed.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
      return 'Enter an absolute path to a checkout on this machine.'
    }
    return null
  }
  if (trimmed.startsWith('/') || trimmed.includes('\\')) {
    return 'This provider expects an owner/repo slug, not a filesystem path.'
  }
  return null
}
