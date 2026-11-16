import type { ExternalRef } from '@coro-ai/cloud-protocol'

/**
 * Turn an SCM failure to read a pull request into the next step the user can
 * take. The raw `GitHub 401: {"message":"Bad credentials",…}` names neither
 * which credential failed nor where to fix it, and a 404 on a private
 * repository reads as "the PR does not exist" when it almost always means
 * "the connected account cannot see it".
 */
export function describePrReadError(
  err: unknown,
  ref: ExternalRef,
  providerName: string,
): string {
  const raw = err instanceof Error ? err.message : String(err)
  const status = (err as { statusCode?: unknown } | null)?.statusCode
  const settings = `Settings → Integrations → ${providerName}`
  const isGitHub = ref.pluginId === 'github'

  if (status === 401) {
    return [
      `${providerName} rejected the saved credentials, so Coro could not read ${ref.url}.`,
      isGitHub
        ? 'The token has probably been revoked or has expired. Signing out of the GitHub CLI, or signing in again, revokes the token Coro saved from it.'
        : 'The token has probably been revoked or has expired.',
      `Reconnect under ${settings}.`,
    ].join(' ')
  }

  if (status === 404) {
    const owner = ref.repoKey?.split('/')[0]
    return [
      `The connected ${providerName} account cannot see ${ref.url}.`,
      `${providerName} answers "Not Found" when a private repository is not shared with the account, so this usually means the wrong account is connected.`,
      `Connect an account that can access ${owner ?? 'this repository'} under ${settings}.`,
      isGitHub
        ? 'If it already has access, the organisation may restrict third-party apps: an organisation owner has to approve the GitHub CLI.'
        : '',
    ].filter(Boolean).join(' ')
  }

  return `Could not read ${ref.url}: ${raw}`
}
