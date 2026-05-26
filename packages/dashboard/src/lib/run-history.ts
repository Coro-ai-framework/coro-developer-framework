import type { Job } from '../types'

export interface RunHistoryHints {
  recentRepos: string[]
  recentReviewers: string[]
}

/** Derive recent repos and reviewers from past runs (most recent first). */
export function deriveRunHistoryHints(jobs: Job[], limit = 5): RunHistoryHints {
  const repos: string[] = []
  const reviewers: string[] = []
  const seenRepos = new Set<string>()
  const seenReviewers = new Set<string>()

  const sorted = [...jobs].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )

  for (const job of sorted) {
    const repo =
      (typeof job.params?.['repo'] === 'string' && job.params['repo']) ||
      (typeof job.params?.['repoSlug'] === 'string' && job.params['repoSlug']) ||
      ''
    if (repo && !seenRepos.has(repo)) {
      seenRepos.add(repo)
      repos.push(repo)
    }

    const raw = job.params?.['reviewers']
    if (Array.isArray(raw)) {
      for (const r of raw) {
        if (typeof r === 'string' && r.trim() && !seenReviewers.has(r.trim())) {
          seenReviewers.add(r.trim())
          reviewers.push(r.trim())
        }
      }
    }

    if (repos.length >= limit && reviewers.length >= limit) break
  }

  return {
    recentRepos: repos.slice(0, limit),
    recentReviewers: reviewers.slice(0, limit),
  }
}

/** Simple keyword overlap for "similar runs" sidebar (UI only, not LLM grounding). */
export function findSimilarRuns(jobs: Job[], intent: string, repo?: string, limit = 3): Job[] {
  const words = intent
    .toLowerCase()
    .split(/\W+/)
    .filter(w => w.length > 3)
  if (words.length === 0 && !repo) return []

  const scored = jobs
    .filter(j => !['cancelled', 'canceled'].includes(j.status))
    .map(job => {
      let score = 0
      const jobRepo =
        (typeof job.params?.['repo'] === 'string' && job.params['repo']) ||
        (typeof job.params?.['repoSlug'] === 'string' && job.params['repoSlug']) ||
        ''
      if (repo && jobRepo === repo) score += 5
      const desc =
        (typeof job.params?.['description'] === 'string' && job.params['description']) ||
        (typeof job.params?.['serviceName'] === 'string' && job.params['serviceName']) ||
        ''
      const hay = desc.toLowerCase()
      for (const w of words) {
        if (hay.includes(w)) score += 1
      }
      return { job, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)

  return scored.slice(0, limit).map(x => x.job)
}
