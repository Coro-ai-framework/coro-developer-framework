// ── GitHub credential probe ──────────────────────────────────────────────────
//
// Backs the dashboard's "Test connection" button via the generic
// `POST /test/plugin/:id` endpoint.
//
// Each check corresponds to a way GitHub credentials pass a naive `/user`
// ping and then fail during a job: a token with no `repo` scope can read the
// API but not push; a token that authenticates as a user may have no access
// to the configured org (SSO often requires separate authorisation); and REST
// access does not guarantee git-over-HTTPS access.

import type { PluginTestCheck, PluginTestResult } from '../../types'
import { describeHttpFailure, probeGitHttps } from '../../probe-http'

export interface GitHubProbeInput {
  owner: string
  token: string
  baseUrl?: string
  fetchFn: typeof fetch
}

export async function probeGitHubCredentials(
  input: GitHubProbeInput,
): Promise<PluginTestResult> {
  const { owner, token, fetchFn } = input
  const api = (input.baseUrl ?? 'https://api.github.com').replace(/\/$/, '')
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'coro-runner',
  }
  const checks: PluginTestCheck[] = []

  const userRes = await fetchFn(`${api}/user`, { headers })
  if (!userRes.ok) {
    const detail = await describeHttpFailure(userRes)
    return {
      ok: false,
      message: `GitHub rejected the token (${detail}).`,
      hint: "Check the token hasn't expired and grants the 'repo' scope.",
      checks: [{ name: 'REST auth', ok: false, message: detail }],
    }
  }
  const user = (await userRes.json()) as { login?: string }
  const login = user.login ?? '(unknown)'
  checks.push({ name: 'REST auth', ok: true, message: `Authenticated as ${login}.` })

  // Classic PATs report their scopes in a response header. Fine-grained and
  // app tokens do not, and there is no other way to introspect them, so those
  // pass with a note rather than a false failure.
  const scopesHeader = userRes.headers.get('x-oauth-scopes')
  if (scopesHeader === null) {
    checks.push({
      name: 'Token scopes',
      ok: true,
      message: 'Fine-grained or app token (scopes are not introspectable).',
    })
  } else {
    const scopes = scopesHeader.split(',').map(s => s.trim()).filter(Boolean)
    const hasRepo = scopes.includes('repo') || scopes.includes('public_repo')
    checks.push({
      name: 'Token scopes',
      ok: hasRepo,
      message: hasRepo
        ? `Has scope${scopes.length === 1 ? '' : 's'}: ${scopes.join(', ')}.`
        : `Missing "repo" scope (got: ${scopes.join(', ') || 'none'}).`,
      ...(hasRepo
        ? {}
        : { hint: 'Agents need the `repo` scope to push branches, open PRs, and post review comments.' }),
    })
  }

  if (owner && owner.toLowerCase() !== login.toLowerCase()) {
    const orgRes = await fetchFn(`${api}/orgs/${encodeURIComponent(owner)}`, { headers })
    if (orgRes.ok) {
      checks.push({ name: 'Owner access', ok: true, message: `Org "${owner}" is reachable.` })
    } else {
      checks.push({
        name: 'Owner access',
        ok: false,
        message: `Cannot read org/owner "${owner}" (${await describeHttpFailure(orgRes)}).`,
        hint: 'Verify the owner slug, and that the token is authorised for the org — '
          + 'SSO-protected orgs require explicit token approval.',
      })
    }
  }

  // Only meaningful against github.com; GHE clone hosts vary per install.
  if (!input.baseUrl) {
    const repoRes = await fetchFn(
      `${api}/users/${encodeURIComponent(owner || login)}/repos?per_page=1&type=owner`,
      { headers },
    )
    if (repoRes.ok) {
      const repos = (await repoRes.json()) as Array<{ full_name?: string }>
      const sample = repos[0]?.full_name
      if (sample) {
        // `x-access-token` is what `cloneInfo()` puts in the clone URL, so
        // this probes the exact credential shape jobs will use.
        const probe = await probeGitHttps(`https://github.com/${sample}.git`, 'x-access-token', token)
        checks.push({
          name: 'Git over HTTPS',
          ok: probe.ok,
          message: probe.ok
            ? `git clone/push will work for ${sample} (${probe.detail}).`
            : `git smart-HTTP handshake failed (${probe.detail}).`,
          ...(probe.ok ? {} : { hint: 'The token likely lacks `repo` scope for git operations.' }),
        })
      }
    }
  }

  const ok = checks.every(c => c.ok)
  return {
    ok,
    message: ok
      ? `Connected to GitHub as ${login}`
      : 'GitHub credentials have problems — see the checks below.',
    checks,
  }
}
