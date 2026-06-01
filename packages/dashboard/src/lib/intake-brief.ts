export interface BriefDraft {
  repo: string
  serviceName: string
  description: string
  /** Comma-separated reviewer names as typed in the Run brief form. Parsed at dispatch time. */
  reviewers: string
  workflowPath: string
  interactive: boolean
}

/** Split a comma-separated reviewers field into trimmed, non-empty names. */
export function parseReviewersList(text: string): string[] {
  return text.split(',').map(s => s.trim()).filter(Boolean)
}

export function parseBrief(assistantMessage: string, knownWorkflowPaths: string[]): BriefDraft | null {
  const match = assistantMessage.match(/<brief>\s*([\s\S]*?)\s*<\/brief>/i)
  if (!match?.[1]) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1].trim())
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>

  const repo = typeof obj.repo === 'string' ? obj.repo.trim() : ''
  const serviceName = typeof obj.serviceName === 'string' ? obj.serviceName.trim() : ''
  const description = typeof obj.description === 'string' ? obj.description.trim() : ''
  const workflowPath = typeof obj.workflowPath === 'string' ? obj.workflowPath.trim() : ''
  const interactive = obj.interactive !== false

  if (!repo || description.length < 20) return null
  if (!knownWorkflowPaths.includes(workflowPath)) return null

  let reviewers = ''
  if (Array.isArray(obj.reviewers)) {
    reviewers = obj.reviewers
      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      .join(', ')
  } else if (typeof obj.reviewers === 'string') {
    reviewers = obj.reviewers.trim()
  }

  return {
    repo,
    serviceName: serviceName || repo.split('/').pop() || repo,
    description,
    reviewers,
    workflowPath,
    interactive,
  }
}

export function briefToSummary(brief: BriefDraft, workflowName: string): string {
  const reviewerList = parseReviewersList(brief.reviewers)
  return `Coro will work on \`${brief.repo}\` (${brief.serviceName}), run the ${workflowName} workflow${
    brief.interactive ? ', pause at checkpoints' : ' end-to-end'
  }${reviewerList.length ? `, and open a PR for ${reviewerList.join(', ')}` : ''}.`
}
