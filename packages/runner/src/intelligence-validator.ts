import yaml from 'js-yaml'

// Per-kind validation for intelligence files written via the dashboard /
// CLI. The validator is intentionally lenient — it catches obvious
// mistakes (missing front matter, non-string fields, empty body) but
// does not try to enforce every nuance of how the runner consumes a
// file. Treat warnings as guidance, not errors.

export type ArtefactKind = 'workflow' | 'agent' | 'skill' | 'memory'

export interface ValidationResult {
  ok: boolean
  errors: string[]
  warnings: string[]
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/

function parseFrontMatter(markdown: string): { fm: Record<string, unknown> | null; rawErr: string | null } {
  const m = FRONT_MATTER_RE.exec(markdown)
  if (!m) return { fm: null, rawErr: null }
  try {
    const v = yaml.load(m[1])
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return { fm: v as Record<string, unknown>, rawErr: null }
    }
    return { fm: null, rawErr: 'YAML front matter must be a mapping' }
  } catch (err) {
    return { fm: null, rawErr: `YAML parse error: ${(err as Error).message}` }
  }
}

function inferKindFromPath(p: string): ArtefactKind | null {
  if (p.startsWith('workflows/')) return 'workflow'
  if (p.startsWith('agents/')) return 'agent'
  if (p.startsWith('.claude/skills/')) return 'skill'
  if (p.startsWith('memory/')) return 'memory'
  return null
}

export function inferKind(p: string): ArtefactKind | null {
  return inferKindFromPath(p)
}

export function validateArtefact(kind: ArtefactKind, path: string, content: string): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (typeof content !== 'string') {
    errors.push('content must be a string')
    return { ok: false, errors, warnings }
  }
  if (content.trim().length === 0) {
    errors.push('content is empty')
    return { ok: false, errors, warnings }
  }

  switch (kind) {
    case 'workflow':
      validateWorkflow(path, content, errors, warnings)
      break
    case 'agent':
      validateAgent(content, errors, warnings)
      break
    case 'skill':
      validateSkill(path, content, errors, warnings)
      break
    case 'memory':
      validateMemory(content, errors, warnings)
      break
  }

  return { ok: errors.length === 0, errors, warnings }
}

function validateWorkflow(
  path: string,
  content: string,
  errors: string[],
  warnings: string[],
): void {
  if (!path.endsWith('/workflow.md') || path.split('/').length !== 3) {
    errors.push('workflow path must be workflows/<id>/workflow.md')
  }
  const { fm, rawErr } = parseFrontMatter(content)
  if (rawErr) {
    errors.push(rawErr)
    return
  }
  if (!fm) {
    errors.push('missing YAML front matter (--- ... ---) at top of file')
    return
  }
  if (typeof fm.initial_phase !== 'string' || !fm.initial_phase) {
    errors.push('front matter: initial_phase (string) is required')
  }
  if (typeof fm.initial_status !== 'string' || !fm.initial_status) {
    errors.push('front matter: initial_status (string) is required')
  }
  if (!Array.isArray(fm.phases) || fm.phases.length === 0) {
    errors.push('front matter: phases must be a non-empty array')
  } else {
    fm.phases.forEach((p, i) => {
      if (!p || typeof p !== 'object') {
        errors.push(`phases[${i}]: must be a mapping`)
        return
      }
      const ph = p as Record<string, unknown>
      if (typeof ph.name !== 'string' || !ph.name) errors.push(`phases[${i}].name (string) is required`)
      if (typeof ph.status !== 'string' || !ph.status) errors.push(`phases[${i}].status (string) is required`)
      if (ph.agent != null && typeof ph.agent !== 'string') errors.push(`phases[${i}].agent must be a string or null`)
    })
    if (typeof fm.initial_phase === 'string') {
      const names = fm.phases.map(p => (p as Record<string, unknown>)?.name).filter(n => typeof n === 'string')
      if (!names.includes(fm.initial_phase)) {
        errors.push(`initial_phase "${fm.initial_phase}" does not match any phases[].name`)
      }
    }
  }
  if (fm.kind != null && fm.kind !== 'job' && fm.kind !== 'campaign' && fm.kind !== 'internal') {
    warnings.push(`front matter: kind "${String(fm.kind)}" is unrecognised (expected job|campaign|internal)`)
  }
  if (typeof fm.display_name !== 'string' || !fm.display_name) {
    warnings.push('front matter: display_name not set — the dashboard will fall back to the H1 heading')
  }
}

function validateAgent(content: string, errors: string[], warnings: string[]): void {
  // Agents don't require front matter, but they should at least have an H1.
  const stripped = content.replace(FRONT_MATTER_RE, '').trimStart()
  if (!/^#\s+\S/m.test(stripped)) {
    errors.push('agent file must contain an H1 heading (e.g. "# Agent: Coder")')
  }
  if (stripped.length < 40) {
    warnings.push('agent body is very short — consider documenting role + procedure')
  }
}

function validateSkill(path: string, content: string, errors: string[], warnings: string[]): void {
  if (!path.endsWith('/SKILL.md')) {
    errors.push('skill path must be .claude/skills/<name>/SKILL.md')
  }
  const { fm, rawErr } = parseFrontMatter(content)
  if (rawErr) {
    errors.push(rawErr)
    return
  }
  if (!fm) {
    errors.push('missing YAML front matter (--- ... ---) at top of file')
    return
  }
  if (typeof fm.name !== 'string' || !fm.name) errors.push('front matter: name (string) is required')
  if (typeof fm.description !== 'string' || !fm.description) {
    errors.push('front matter: description (string) is required')
  }
  if (path.endsWith('/SKILL.md')) {
    const dirName = path.split('/').slice(-2, -1)[0]
    if (typeof fm.name === 'string' && fm.name && fm.name !== dirName) {
      warnings.push(`front matter: name "${fm.name}" does not match folder name "${dirName}"`)
    }
  }
}

function validateMemory(content: string, _errors: string[], warnings: string[]): void {
  // Memory is the most permissive — runtime concatenates everything. We
  // only emit gentle warnings.
  const stripped = content.replace(FRONT_MATTER_RE, '').trimStart()
  if (!/^#\s+\S/m.test(stripped)) {
    warnings.push('memory file has no H1 — consider adding one for dashboard display')
  }
}
