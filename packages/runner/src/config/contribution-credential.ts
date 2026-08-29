// ── Contribution credential ──────────────────────────────────────────────────
//
// Coro has one idea of "who am I to a git host": the SCM plugin. Contribution
// settings (`upstream.*`) introduced a second identity, but only half of one —
// it authenticated the retrospective's own REST calls (search issues, file an
// issue, `ensureFork`, `syncFork`) and nothing else. Everything the dispatched
// oss-contribution job did afterwards — `git push` to the fork, opening the
// cross-repository pull request — still authenticated as the SCM plugin.
//
// Whenever `upstream.token` names a different account than the GitHub plugin,
// those two halves disagree, and the disagreement is not recoverable inside a
// job: the fork belongs to the contribution account, so the plugin account
// cannot push to it, and GitHub only says so after the work is committed. The
// invariant this module restores is that **the identity that owns the fork is
// the identity that writes to the fork**.
//
// The identity is keyed by **repository**, not by job type, and that is a
// structural requirement rather than a preference. The git credential helper
// runs as a separate process (`coro git-credential`) which receives nothing
// but protocol/host/path from git — no job id, no params, no state backend. A
// rule about repositories can be derived from config alone, so the helper and
// the in-process plugin reach the same answer without either knowing what a
// job is.
//
// Two slugs belong to this identity:
//
//   - **the fork**, which is what the job clones and pushes to; and
//   - **the upstream repository**, because a cross-repository pull request is
//     created against upstream with a head branch on the fork, and GitHub
//     attributes that call to whoever owns the head.
//
// No override exists when `upstream.token` is unset. That is not a gap: the
// fork is then created with the plugin's own token, so the plugin identity
// already *is* the contribution identity and there is nothing to swap.

/** The subset of resolved upstream settings this identity is derived from. */
export interface ContributionCredentialSource {
  repoUrl: string
  forkOwner?: string
  token?: string
}

export interface ContributionCredential {
  /** Host the covered repositories live on, lowercased (`github.com`). */
  host: string
  /** Account that owns the fork — who this credential authenticates as. */
  owner: string
  /** Lowercased `owner/repo` slugs this identity owns: the fork, and upstream. */
  repoSlugs: readonly string[]
  /** HTTPS basic-auth username. */
  username: string
  /** The token from `upstream.token`. */
  password: string
}

// GitHub's HTTPS basic-auth convention, which the GitHub plugin's `cloneInfo`
// is the authority on. It is repeated here because this credential has to work
// in the credential-helper process, which may answer for the contribution fork
// before any plugin has claimed the host — the same reason
// `builtin/github/test-connection.ts` repeats it.
const GITHUB_HTTPS_USERNAME = 'x-access-token'

/**
 * The contribution identity for this install, or `undefined` when writes to
 * the fork should keep using the SCM plugin's credentials.
 *
 * All three inputs are required. A missing `forkOwner` means the fork lives
 * under the GitHub plugin's own owner, and a missing `token` means it was
 * created with the plugin's own token — either way the plugin identity is
 * already correct, and inventing an override would be the bug this module
 * exists to prevent.
 */
export function resolveContributionCredential(
  upstream: ContributionCredentialSource | undefined,
): ContributionCredential | undefined {
  const token = upstream?.token?.trim()
  const forkOwner = upstream?.forkOwner?.trim()
  if (!upstream?.repoUrl || !token || !forkOwner) return undefined

  const target = parseRepoTarget(upstream.repoUrl)
  if (!target) return undefined

  // Must agree with `GitHubClient.ensureFork`, which looks for the fork at
  // `<forkOwner>/<upstream repo name>` and refuses to adopt anything else at
  // that address. If these two ever disagree, the job authenticates as one
  // account against a fork created by another — the original defect.
  const forkSlug = normalizeRepoSlug(`${forkOwner}/${target.repo}`)
  const upstreamSlug = normalizeRepoSlug(target.slug)

  return {
    host: target.host,
    owner: forkOwner,
    repoSlugs: [...new Set([forkSlug, upstreamSlug])],
    username: GITHUB_HTTPS_USERNAME,
    password: token,
  }
}

/**
 * Whether this credential owns `repoSlug`. Pass `host` where it is known (the
 * credential-helper protocol supplies one) so a same-named repository on a
 * different host can never match; omit it in a plugin that already serves a
 * single host.
 *
 * A bare repository name never matches. Bare names resolve against the SCM
 * plugin's configured owner, which by definition is not the contribution
 * account.
 */
export function contributionCredentialCovers(
  credential: ContributionCredential | undefined,
  repoSlug: string,
  host?: string,
): boolean {
  if (!credential) return false
  if (host && host.trim().toLowerCase() !== credential.host) return false
  const slug = normalizeRepoSlug(repoSlug)
  if (!slug.includes('/')) return false
  return credential.repoSlugs.includes(slug)
}

/** Lowercased `owner/repo`, with `.git`, surrounding slashes, and query noise gone. */
export function normalizeRepoSlug(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase()
}

/**
 * Host, `owner/repo`, and bare repo name from a repository URL or slug.
 * Deliberately local rather than reusing the writer's `parseRepoUrl`: this
 * module is loaded by the credential-helper process, and it stays free of
 * git and plugin imports so that process keeps paying for nothing it does
 * not use.
 */
function parseRepoTarget(raw: string): { host: string; slug: string; repo: string } | undefined {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return undefined

  let host = 'github.com'
  let pathPart = trimmed

  const scpLike = /^[^@/]+@([^:]+):(.+)$/.exec(trimmed)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      host = url.hostname
      pathPart = url.pathname
    } catch {
      return undefined
    }
  } else if (scpLike) {
    host = scpLike[1]!
    pathPart = scpLike[2]!
  }

  const parts = normalizeRepoSlug(pathPart).split('/').filter(Boolean)
  if (parts.length < 2) return undefined

  const owner = parts[0]!
  const repo = parts[1]!
  return { host: host.toLowerCase(), slug: `${owner}/${repo}`, repo }
}
