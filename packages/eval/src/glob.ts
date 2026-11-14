/**
 * A deliberately small glob matcher, so the harness needs no dependency for it.
 *
 *   `**`  any run of characters, including `/`
 *   `**` followed by `/`   zero or more whole directories (`**` + `/x` matches `x` and `a/b/x`)
 *   `*`   any run of characters except `/`
 *   `?`   one character except `/`
 *
 * Everything else matches literally. Paths use `/` separators.
 */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!
    if (char === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          source += '(?:.*/)?'
          i += 2
        } else {
          source += '.*'
          i += 1
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
  return new RegExp(`^${source}$`)
}

export function globMatch(glob: string, candidate: string): boolean {
  return globToRegExp(glob).test(candidate)
}

export function matchesAny(globs: readonly string[], candidate: string): boolean {
  return globs.some(glob => globMatch(glob, candidate))
}
