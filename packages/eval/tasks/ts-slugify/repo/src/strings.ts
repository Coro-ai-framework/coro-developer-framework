/** Upper-case the first character of `text`. */
export function capitalize(text: string): string {
  if (text.length === 0) return text
  return text[0]!.toUpperCase() + text.slice(1)
}

/**
 * Shorten `text` to at most `max` characters. When it had to be cut, the last
 * character is an ellipsis.
 */
export function truncate(text: string, max: number): string {
  if (max < 1) return ''
  if (text.length <= max) return text
  if (max === 1) return '…'
  return `${text.slice(0, max - 1)}…`
}
