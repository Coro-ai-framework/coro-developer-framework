export type PromptCategory =
  | 'bug-fix'
  | 'refactor'
  | 'feature-small'
  | 'feature-medium'
  | 'tests'
  | 'docs'
  | 'dependency'
  | 'tracker-triage'

export interface PromptTemplate {
  id: string
  category: PromptCategory
  title: string
  preview: string
  description: string
  mode: 'manual' | 'ticket'
  suggestedWorkflow?: string
  tags?: string[]
}

export const CATEGORY_LABELS: Record<
  PromptCategory,
  { label: string; icon: string; blurb: string }
> = {
  'bug-fix': {
    label: 'Bug fix',
    icon: '🐛',
    blurb: 'Investigate and fix broken behaviour.',
  },
  refactor: {
    label: 'Refactor',
    icon: '♻️',
    blurb: 'Clean up structure without changing behaviour.',
  },
  'feature-small': {
    label: 'Small feature',
    icon: '✨',
    blurb: 'Scoped additions to existing code.',
  },
  'feature-medium': {
    label: 'Medium feature',
    icon: '🚀',
    blurb: 'Multi-file changes with clear acceptance criteria.',
  },
  tests: {
    label: 'Tests',
    icon: '🧪',
    blurb: 'Add or improve test coverage.',
  },
  docs: {
    label: 'Documentation',
    icon: '📝',
    blurb: 'Update README or inline docs.',
  },
  dependency: {
    label: 'Dependency',
    icon: '📦',
    blurb: 'Bump packages and fix breakage.',
  },
  'tracker-triage': {
    label: 'Tracker ticket',
    icon: '🎫',
    blurb: 'Start from an issue in your tracker.',
  },
}

export const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'add-validation',
    category: 'feature-small',
    title: 'Add input validation',
    preview: 'Validate request payloads on an endpoint with clear error messages.',
    description:
      'Add input validation to the `<endpoint>` endpoint. Return 400 with a structured error body when validation fails. Include unit tests for the happy path and at least two failure cases.',
    mode: 'manual',
    tags: ['validation', 'api', 'endpoint'],
  },
  {
    id: 'fix-flaky-test',
    category: 'bug-fix',
    title: 'Fix a flaky test',
    preview: 'Investigate timing or ordering issues causing intermittent failures.',
    description:
      'The test `<test file>` is flaky. Investigate the root cause, fix it, and add a brief comment explaining what made it unstable. The test must pass reliably when run 10 times in a row.',
    mode: 'manual',
    tags: ['test', 'flaky', 'ci'],
  },
  {
    id: 'extract-helper',
    category: 'refactor',
    title: 'Extract a shared helper',
    preview: 'Pull repeated logic into a reusable function without changing behaviour.',
    description:
      'Extract the repeated `<pattern>` block into a shared helper. Update all call sites to use it. Behaviour must remain identical — no functional changes. Add or update tests if coverage would drop.',
    mode: 'manual',
    tags: ['refactor', 'dedupe'],
  },
  {
    id: 'add-rate-limit',
    category: 'feature-small',
    title: 'Add rate limiting',
    preview: 'Protect an endpoint with token-bucket or similar limiting.',
    description:
      'Add rate limiting to `<endpoint>` using the existing `<library>` utility. Return clear retry-after headers when a caller exceeds the limit. Include acceptance criteria: limit applies per caller, headers are present, and existing tests still pass.',
    mode: 'manual',
    tags: ['rate-limit', 'api', 'security'],
  },
  {
    id: 'bump-dependency',
    category: 'dependency',
    title: 'Bump a dependency',
    preview: 'Upgrade a package to the latest compatible version.',
    description:
      'Bump `<package>` to the latest minor version compatible with our runtime. Fix any compile or test breakage. Summarise breaking API changes in the PR description.',
    mode: 'manual',
    tags: ['dependency', 'upgrade'],
  },
  {
    id: 'improve-readme',
    category: 'docs',
    title: 'Update README',
    preview: 'Document a new feature or changed behaviour in the README.',
    description:
      'Update the README to reflect the new `<feature>`. Include setup steps if they changed, and add a short usage example. Keep the tone consistent with the existing doc.',
    mode: 'manual',
    tags: ['docs', 'readme'],
  },
  {
    id: 'add-unit-tests',
    category: 'tests',
    title: 'Add unit tests',
    preview: 'Cover a module with focused unit tests for edge cases.',
    description:
      'Add unit-test coverage for `<module>` focusing on `<edge cases>`. Follow existing test conventions in the repo. Tests must be deterministic and not require network access.',
    mode: 'manual',
    tags: ['tests', 'coverage'],
  },
  {
    id: 'triage-ticket',
    category: 'tracker-triage',
    title: 'Work from a tracker ticket',
    preview: 'Switch to ticket mode — Coro pulls scope from your issue tracker.',
    description: '',
    mode: 'ticket',
    tags: ['jira', 'linear', 'ticket'],
  },
]

export const RECENT_TEMPLATES_KEY = 'coro.promptTemplates.recent'

export function loadRecentTemplateIds(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(RECENT_TEMPLATES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string').slice(0, 3)
  } catch {
    return []
  }
}

export function recordRecentTemplateId(id: string): void {
  if (typeof window === 'undefined') return
  const prev = loadRecentTemplateIds().filter(x => x !== id)
  window.localStorage.setItem(RECENT_TEMPLATES_KEY, JSON.stringify([id, ...prev].slice(0, 3)))
}

/** First `<placeholder>` in angle brackets, for auto-select on focus. */
export function firstPlaceholder(text: string): { start: number; end: number } | null {
  const match = text.match(/<[^>]+>/)
  if (!match || match.index === undefined) return null
  return { start: match.index, end: match.index + match[0].length }
}
