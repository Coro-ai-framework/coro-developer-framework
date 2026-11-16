// Where workflows live in an intelligence layer, and how to move between a
// workflow's id and its path.
//
// A workflow is a Claude Code slash command: `.claude/commands/coro/<id>.md`.
// The id is the file name, so the path can always be rebuilt from it and the
// id can always be read back. This mirrors `workflowPathForSlug` and
// `workflowSlugFromPath` in `@coro-ai/cloud-protocol`, which the runner
// uses; the dashboard does not depend on that package, so the two small
// helpers are repeated here. Keep them in step.

export const WORKFLOWS_DIR = '.claude/commands/coro'

/** `workflowPathForSlug('job')` → `.claude/commands/coro/job.md`. */
export function workflowPathForSlug(slug: string): string {
  return `${WORKFLOWS_DIR}/${slug}.md`
}

/** Inverse of {@link workflowPathForSlug}: the file name without `.md`. */
export function workflowSlugFromPath(workflowPath: string): string {
  const segments = workflowPath.split('/').filter(Boolean)
  const last = segments[segments.length - 1] ?? ''
  return last.replace(/\.md$/i, '') || 'workflow'
}

const LEGACY_WORKFLOW_PATH = /^workflows\/([^/]+)\/workflow\.md$/i

/**
 * The known workflow a path names, or null. Accepts the pre-move layout
 * (`workflows/<id>/workflow.md`): a plan-mode conversation started before
 * workflows moved resumes the same model session, whose system prompt still
 * teaches the old path, so its runs keep naming it.
 */
export function resolveKnownWorkflowPath(workflowPath: string, knownWorkflowPaths: string[]): string | null {
  const trimmed = workflowPath.trim()
  if (knownWorkflowPaths.includes(trimmed)) return trimmed
  const legacy = trimmed.match(LEGACY_WORKFLOW_PATH)?.[1]
  if (!legacy) return null
  const current = workflowPathForSlug(legacy)
  return knownWorkflowPaths.includes(current) ? current : null
}
