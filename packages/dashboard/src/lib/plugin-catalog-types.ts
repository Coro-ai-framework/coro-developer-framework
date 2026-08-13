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

export interface PluginCatalogEntry {
  id: string
  kind: string
  displayName: string
  ui?: {
    customPanel?: string
    subtitle?: string
    recommendedForOnboarding?: boolean
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
  /** False when the runner has no OAuth client ID configured. */
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
