import type { SettingStatus } from '../../components/settings/StatusBadge'
import type {
  SettingsDraft,
  SettingsSectionId,
  ClaudeLoginState,
  ClaudeAccountInfo,
} from './SettingsContext'

interface ReadinessInput {
  draft: SettingsDraft
  claudeLogin: ClaudeLoginState
  claudeLoginAccount: ClaudeAccountInfo | null
}

export interface ReadinessSummary {
  /** Per-section status; what the sidebar dots and section header pills show. */
  byId: Record<SettingsSectionId, { status: SettingStatus; label?: string; detail?: string }>
  /** Required-to-run-jobs gate. */
  ready: boolean
  /** Section ids that are required and not yet satisfied. */
  missingRequired: SettingsSectionId[]
}

export function evaluateReadiness({ draft, claudeLogin, claudeLoginAccount }: ReadinessInput): ReadinessSummary {
  // LLM provider ──
  const account = claudeLogin.account ?? claudeLoginAccount
  const claudeReady = claudeLogin.status === 'connected' || !!account
  const llmReady =
    (draft.anthropicMethod === 'claudeLogin' && claudeReady) ||
    (draft.anthropicMethod === 'apiKey' && draft.apiKey.length > 0) ||
    (draft.anthropicMethod === 'oauth' && draft.oauthToken.length > 0)
  const llmDetail =
    draft.anthropicMethod === 'claudeLogin'
      ? claudeReady
        ? 'Claude login connected'
        : 'Claude login not connected'
      : draft.anthropicMethod === 'apiKey'
        ? draft.apiKey
          ? 'API key configured'
          : 'API key missing'
        : draft.oauthToken
          ? 'Legacy token configured'
          : 'Legacy token missing'

  // Source control ──
  const gitConfigured = Boolean(draft.gitUsername && draft.gitToken)
  const gitDetail = gitConfigured
    ? `${draft.gitProvider} · ${draft.gitUsername}`
    : 'Git credentials missing'

  // Issue tracker (optional) ──
  let trackerStatus: SettingStatus = 'optional'
  let trackerDetail = 'Tracker disabled'
  if (draft.trackerProvider === 'jira') {
    const ok = !!(draft.jiraBaseUrl && draft.jiraUsername && draft.jiraApiToken)
    trackerStatus = ok ? 'ok' : 'warn'
    trackerDetail = ok ? 'Jira connected' : 'Jira fields incomplete'
  } else if (draft.trackerProvider === 'linear') {
    const ok = draft.linearApiKey.length > 0
    trackerStatus = ok ? 'ok' : 'warn'
    trackerDetail = ok ? 'Linear connected' : 'Linear API key missing'
  } else if (draft.trackerProvider === 'github') {
    const ok = gitConfigured && draft.gitProvider === 'github'
    trackerStatus = ok ? 'ok' : 'warn'
    trackerDetail = ok ? 'GitHub Issues via Git creds' : 'Configure GitHub in Source control first'
  }

  // Extensions / advanced are informational only ──
  const mcpDetail = (() => {
    try {
      const parsed = JSON.parse(draft.mcpServersText) as Record<string, unknown>
      const count = parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 0
      return count === 0
        ? 'No BYO servers configured'
        : `${count} server${count === 1 ? '' : 's'} configured`
    } catch {
      return 'Invalid JSON'
    }
  })()

  const byId: ReadinessSummary['byId'] = {
    'llm-provider': {
      status: llmReady ? 'ok' : 'warn',
      label: llmReady ? 'Connected' : 'Needs setup',
      detail: llmDetail,
    },
    'source-control': {
      status: gitConfigured ? 'ok' : 'warn',
      label: gitConfigured ? 'Connected' : 'Needs setup',
      detail: gitDetail,
    },
    'issue-tracker': {
      status: trackerStatus,
      detail: trackerDetail,
    },
    plugins: {
      status: 'optional',
      detail: 'Built-ins enabled by Source control + Tracker config',
    },
    mcp: {
      status: 'optional',
      detail: mcpDetail,
    },
    paths: {
      status: 'optional',
      detail: 'Using resolved defaults unless overridden',
    },
  }

  const missingRequired: SettingsSectionId[] = []
  if (!llmReady) missingRequired.push('llm-provider')
  if (!gitConfigured) missingRequired.push('source-control')

  return {
    byId,
    ready: missingRequired.length === 0,
    missingRequired,
  }
}
