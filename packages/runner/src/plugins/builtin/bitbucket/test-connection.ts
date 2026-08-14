// ── Bitbucket credential probe ───────────────────────────────────────────────
//
// Backs the dashboard's "Test connection" button via the generic
// `POST /test/plugin/:id` endpoint.
//
// Deliberately more than a `/user` ping. Every check here corresponds to a
// way Bitbucket credentials pass a naive test and then fail mid-job:
//
//   - REST accepts the account e-mail while git-over-HTTPS requires
//     `x-bitbucket-api-token-auth` for the same ATATT token.
//   - A token that authenticates fine has no access to the configured
//     workspace, so every clone 404s.
//   - Reviewer credentials point at the same account as the coder, and
//     Bitbucket refuses self-approval, so the review phase hangs forever.

import type { PluginTestCheck, PluginTestResult } from '../../types'
import { describeHttpFailure, probeGitHttps } from '../../probe-http'

const API_BASE = 'https://api.bitbucket.org/2.0'

export interface BitbucketProbeInput {
  username: string
  token: string
  workspace: string
  reviewerUsername?: string
  reviewerToken?: string
  /** Reads the saved coderUsername, used to suggest an alternate username. */
  savedUsername?: string
}

function basic(username: string, token: string): string {
  return Buffer.from(`${username}:${token}`).toString('base64')
}

function headers(username: string, token: string): Record<string, string> {
  return { Authorization: `Basic ${basic(username, token)}`, 'User-Agent': 'coro-runner' }
}

/** Mirrors the plugin's own `deriveGitUsername` without importing from it. */
function deriveGitUsername(typedUsername: string, token: string): string {
  const isAtlassianApiToken = token.startsWith('ATATT')
  if (isAtlassianApiToken && typedUsername.includes('@')) return 'x-bitbucket-api-token-auth'
  return typedUsername
}

/**
 * Atlassian ships two token types that both start with `ATATT` but accept
 * different usernames. When the typed one is rejected, try the other shape so
 * the error can name the fix instead of just reporting 401.
 */
async function tryAlternateUsername(
  input: BitbucketProbeInput,
): Promise<{ alternate: string; works: boolean } | null> {
  const { username, token, savedUsername } = input
  let alternate: string | null = null
  if (username.includes('@')) {
    alternate = 'x-bitbucket-api-token-auth'
  } else if (/^x-[\w-]+-auth$/.test(username) && savedUsername?.includes('@')) {
    alternate = savedUsername
  }
  if (!alternate) return null
  try {
    const res = await fetch(`${API_BASE}/user`, { headers: headers(alternate, token) })
    return { alternate, works: res.ok }
  } catch {
    return { alternate, works: false }
  }
}

export async function probeBitbucketCredentials(
  input: BitbucketProbeInput,
): Promise<PluginTestResult> {
  const { username, token, workspace } = input
  const checks: PluginTestCheck[] = []

  if (!username) {
    return {
      ok: false,
      message: 'Bitbucket requires a username for Basic auth.',
      checks: [{ name: 'Inputs', ok: false, message: 'Username is empty.' }],
    }
  }
  if (!workspace) {
    checks.push({
      name: 'Inputs',
      ok: false,
      message: 'Workspace slug is empty — agents will not be able to clone or push.',
    })
  }

  const restRes = await fetch(`${API_BASE}/user`, { headers: headers(username, token) })
  if (!restRes.ok) {
    const detail = await describeHttpFailure(restRes)
    const alt = await tryAlternateUsername(input)
    const hint = alt?.works
      ? `Your token authenticates as "${alt.alternate}", not "${username}". `
        + `Change the coder username to "${alt.alternate}" — Atlassian's two ATATT token types `
        + 'share the prefix but accept different usernames.'
      : 'Verify the token matches the username: an e-mail for id.atlassian.com API tokens, '
        + '`x-bitbucket-api-token-auth` for Bitbucket-scoped tokens.'
    return {
      ok: false,
      message: `Bitbucket rejected the credentials (${detail}).`,
      checks: [...checks, { name: 'REST auth (coder)', ok: false, message: detail, hint }],
    }
  }
  const coder = (await restRes.json()) as {
    username?: string
    display_name?: string
    uuid?: string
  }
  checks.push({
    name: 'REST auth (coder)',
    ok: true,
    message: `Authenticated as ${coder.display_name ?? coder.username ?? username}.`,
  })

  let sampleRepoSlug: string | undefined
  if (workspace) {
    const wsRes = await fetch(
      `${API_BASE}/workspaces/${encodeURIComponent(workspace)}`,
      { headers: headers(username, token) },
    )
    checks.push({
      name: 'Workspace access',
      ok: wsRes.ok,
      message: wsRes.ok
        ? `Workspace "${workspace}" is reachable.`
        : `Cannot read workspace "${workspace}" (${await describeHttpFailure(wsRes)}).`,
      ...(wsRes.ok
        ? {}
        : { hint: 'Check the slug (case-sensitive) and that the token has access to this workspace.' }),
    })

    const repoRes = await fetch(
      `${API_BASE}/repositories/${encodeURIComponent(workspace)}?pagelen=1&fields=values.slug,values.full_name`,
      { headers: headers(username, token) },
    )
    if (repoRes.ok) {
      const data = (await repoRes.json()) as { values?: Array<{ slug?: string; full_name?: string }> }
      sampleRepoSlug = data.values?.[0]?.slug
      checks.push({
        name: 'Repository scope',
        ok: true,
        message: sampleRepoSlug
          ? `Token can list repositories (sampled "${data.values?.[0]?.full_name}").`
          : 'Token can list repositories, but the workspace currently has none.',
      })
    } else {
      checks.push({
        name: 'Repository scope',
        ok: false,
        message: `Cannot list repos in "${workspace}" (${await describeHttpFailure(repoRes)}).`,
        hint: 'The token likely lacks the `repository:read` scope.',
      })
    }
  }

  if (sampleRepoSlug && workspace) {
    const gitUsername = deriveGitUsername(username, token)
    const probe = await probeGitHttps(
      `https://bitbucket.org/${workspace}/${sampleRepoSlug}.git`,
      gitUsername,
      token,
    )
    checks.push({
      name: 'Git over HTTPS',
      ok: probe.ok,
      message: probe.ok
        ? `git clone/push will authenticate as "${gitUsername}" (${probe.detail}).`
        : `git smart-HTTP handshake failed for "${gitUsername}" (${probe.detail}).`,
      ...(probe.ok
        ? {}
        : {
            hint: gitUsername === username
              ? 'For Atlassian API tokens, git over HTTPS often needs `x-bitbucket-api-token-auth` '
                + 'as the username even though REST accepted your e-mail.'
              : 'Coro rewrites the git username for ATATT tokens automatically. If this still fails, '
                + 'the token may be a Bitbucket-scoped token that needs the literal configured username.',
          }),
    })
  }

  if (input.reviewerToken && input.reviewerToken !== token) {
    const reviewerUsername = (input.reviewerUsername ?? '').trim() || username
    const revRes = await fetch(`${API_BASE}/user`, {
      headers: headers(reviewerUsername, input.reviewerToken),
    })
    if (revRes.ok) {
      const reviewer = (await revRes.json()) as {
        username?: string
        display_name?: string
        uuid?: string
      }
      const sameAccount = Boolean(reviewer.uuid && coder.uuid && reviewer.uuid === coder.uuid)
      checks.push({
        name: 'REST auth (reviewer)',
        ok: !sameAccount,
        message: sameAccount
          ? 'Reviewer is the same Bitbucket account as the coder — Bitbucket forbids self-approval, '
            + 'so the review phase will hang.'
          : `Authenticated as ${reviewer.display_name ?? reviewer.username ?? reviewerUsername}.`,
        ...(sameAccount
          ? { hint: 'Use a separate Bitbucket account, or no reviewer credentials at all.' }
          : {}),
      })
    } else {
      checks.push({
        name: 'REST auth (reviewer)',
        ok: false,
        message: `Reviewer auth failed (${await describeHttpFailure(revRes)}).`,
        hint: 'Same username rules as the coder account.',
      })
    }
  }

  const ok = checks.every(c => c.ok)
  return {
    ok,
    message: ok
      ? `Connected to Bitbucket workspace ${workspace} as ${coder.display_name ?? username}`
      : 'Bitbucket credentials have problems — see the checks below.',
    checks,
  }
}
