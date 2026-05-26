export interface BriefDraft {
  repo: string
  serviceName: string
  description: string
  reviewers: string[]
  workflowPath: string
  interactive: boolean
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

  let reviewers: string[] = []
  if (Array.isArray(obj.reviewers)) {
    reviewers = obj.reviewers.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
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
  return `Coro will work on \`${brief.repo}\` (${brief.serviceName}), run the ${workflowName} workflow${
    brief.interactive ? ', pause at checkpoints' : ' end-to-end'
  }${brief.reviewers.length ? `, and open a PR for ${brief.reviewers.join(', ')}` : ''}.`
}
