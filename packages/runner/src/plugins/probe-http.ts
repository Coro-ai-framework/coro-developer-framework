// ── Shared credential-probe helpers ──────────────────────────────────────────
//
// Small building blocks for a plugin's `testConnection`. They live here rather
// than in any one plugin because every git host needs the same two things: a
// readable description of an HTTP failure, and a way to check that a
// credential works for `git` and not only for the REST API.

/** Short-form HTTP detail for a non-200 response. */
export async function describeHttpFailure(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  const trimmed = text.trim().slice(0, 200)
  if (trimmed.length > 0) return `${res.status}: ${trimmed}`
  return `${res.status} ${res.statusText || ''}`.trim()
}

/**
 * Hit a repository's smart-HTTP `info/refs` endpoint with Basic auth.
 *
 * Worth a separate check because REST access and git access are not the same
 * permission. Bitbucket is the sharp case: for an Atlassian API token, REST
 * accepts the user's e-mail while git requires
 * `x-bitbucket-api-token-auth`, so a REST-only test reports success and the
 * user finds out when an agent's `git push` returns 401 mid-job.
 */
export async function probeGitHttps(
  repoCloneBase: string,
  gitUsername: string,
  token: string,
): Promise<{ ok: boolean; detail: string }> {
  const url = `${repoCloneBase.replace(/\/+$/, '')}/info/refs?service=git-upload-pack`
  const auth = Buffer.from(`${gitUsername}:${token}`).toString('base64')
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        'User-Agent': 'git/2.40.0',
        // Required by the smart-HTTP protocol; servers reject the request
        // otherwise even with valid credentials.
        Accept: 'application/x-git-upload-pack-advertisement',
      },
    })
    if (res.ok) {
      const contentType = res.headers.get('content-type') ?? ''
      if (!contentType.includes('git-upload-pack-advertisement')) {
        return { ok: false, detail: `${res.status} but unexpected content-type "${contentType}"` }
      }
      return { ok: true, detail: `${res.status} (git smart-HTTP handshake accepted)` }
    }
    return { ok: false, detail: await describeHttpFailure(res) }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
