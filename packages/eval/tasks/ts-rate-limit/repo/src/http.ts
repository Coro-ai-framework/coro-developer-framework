import type { Response } from './types'

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body }
}

/** Read a request header without caring how the caller cased its name. */
export function header(headers: Record<string, string | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value
  }
  return undefined
}
