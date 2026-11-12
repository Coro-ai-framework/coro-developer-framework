// ── Path globs ───────────────────────────────────────────────────────────────
//
// The review settings name paths with the same small glob language: `**`
// crosses directories, `*` and `?` stay inside one, and a pattern with no
// slash matches a file name at any depth (`CODEOWNERS`, `*.proto`).

const cache = new Map<string, RegExp>()

export function globToRegExp(pattern: string): RegExp {
  const cached = cache.get(pattern)
  if (cached) return cached
  const anywhere = !pattern.includes('/')
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i += 1
        if (pattern[i + 1] === '/') {
          i += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  const regex = new RegExp(`^${anywhere ? '(?:.*/)?' : ''}${source}$`)
  cache.set(pattern, regex)
  return regex
}

export function matchesGlob(pattern: string, filePath: string): boolean {
  return globToRegExp(pattern).test(filePath)
}
