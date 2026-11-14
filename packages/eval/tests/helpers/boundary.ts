import fs from 'node:fs'
import path from 'node:path'

/**
 * The black-box rule, as code.
 *
 * The harness may live in the Coro repo, but it must reach Coro only over the
 * runner's HTTP API, the CLI, and the files Coro leaves behind. The one thing
 * it may share is *types* from `@coro-ai/cloud-protocol`, so a change to the
 * job record fails typecheck here instead of being silently misread.
 *
 * The repo has no ESLint, so the rule is enforced by scanning the sources.
 */

export const ALLOWED_TYPE_ONLY_PACKAGE = '@coro-ai/cloud-protocol'

export interface SourceFile {
  /** Absolute path of the file. */
  file: string
  text: string
}

export interface Violation {
  file: string
  specifier: string
  reason: string
}

interface ImportRef {
  specifier: string
  /** `import type ...` / `export type ... from`. */
  typeOnly: boolean
}

// `import a from 'x'`, `import { a } from 'x'`, `import 'x'`, `export * from 'x'`,
// and their `type` forms. Anchored to a line start so prose in comments and
// string literals that merely contain the word "import" are not matched.
const STATIC_IMPORT = /(?:^|\n)[ \t]*(?:import|export)[ \t]+(type[ \t]+)?(?:[^'";]*?[ \t\n]from[ \t\n]*)?['"]([^'"\n]+)['"]/g
const DYNAMIC_IMPORT = /\b(?:require|import)[ \t]*\([ \t]*['"]([^'"\n]+)['"][ \t]*\)/g

export function extractImports(text: string): ImportRef[] {
  const refs: ImportRef[] = []
  for (const match of text.matchAll(STATIC_IMPORT)) {
    refs.push({ specifier: match[2]!, typeOnly: Boolean(match[1]) })
  }
  for (const match of text.matchAll(DYNAMIC_IMPORT)) {
    refs.push({ specifier: match[1]!, typeOnly: false })
  }
  return refs
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function findViolations(files: SourceFile[], packageRoot: string): Violation[] {
  const violations: Violation[] = []
  for (const { file, text } of files) {
    for (const ref of extractImports(text)) {
      const { specifier } = ref

      if (specifier.startsWith('@coro-ai/')) {
        if (specifier !== ALLOWED_TYPE_ONLY_PACKAGE) {
          violations.push({
            file,
            specifier,
            reason: `only ${ALLOWED_TYPE_ONLY_PACKAGE} may be imported, and only as a type`,
          })
        } else if (!ref.typeOnly) {
          violations.push({
            file,
            specifier,
            reason: `${ALLOWED_TYPE_ONLY_PACKAGE} must be imported with \`import type\` (a runtime import is a runtime dependency on Coro)`,
          })
        }
        continue
      }

      if (specifier.startsWith('.')) {
        const resolved = path.resolve(path.dirname(file), specifier)
        if (!isInside(packageRoot, resolved)) {
          violations.push({ file, specifier, reason: 'relative import leaves packages/eval' })
        }
        continue
      }

      if (path.isAbsolute(specifier)) {
        violations.push({ file, specifier, reason: 'absolute import path' })
      }
    }
  }
  return violations
}

/** `@coro-ai/*` must not appear in `dependencies`; types come from devDependencies. */
export function findManifestViolations(manifest: {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}): string[] {
  const out: string[] = []
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (name.startsWith('@coro-ai/')) out.push(`${field} lists ${name}`)
    }
  }
  return out
}

const SOURCE_EXT = /\.(?:[cm]?[jt]s)$/

export function collectSources(dir: string): SourceFile[] {
  const out: SourceFile[] = []
  if (!fs.existsSync(dir)) return out
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (SOURCE_EXT.test(entry.name)) out.push({ file: full, text: fs.readFileSync(full, 'utf-8') })
    }
  }
  walk(dir)
  return out
}
