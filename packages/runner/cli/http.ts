/**
 * Shared HTTP helpers for the CLI.
 * All commands talk to the Agent Host via its REST API.
 */

const DEFAULT_BASE_URL = 'http://localhost:3000'

export function baseUrl(): string {
  return process.env['CORO_HOST'] ?? DEFAULT_BASE_URL
}

export interface ApiResponse<T = unknown> {
  ok: boolean
  status: number
  data: T
}

export async function apiGet<T = unknown>(path: string): Promise<ApiResponse<T>> {
  const url = `${baseUrl()}${path}`
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  const data = await res.json() as T
  return { ok: res.ok, status: res.status, data }
}

export async function apiPost<T = unknown>(path: string, body: unknown): Promise<ApiResponse<T>> {
  const url = `${baseUrl()}${path}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json() as T
  return { ok: res.ok, status: res.status, data }
}

export async function apiDelete<T = unknown>(path: string): Promise<ApiResponse<T>> {
  const url = `${baseUrl()}${path}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
  })
  // Some endpoints return 204 with no body — handle both.
  const text = await res.text()
  const data = (text ? JSON.parse(text) : {}) as T
  return { ok: res.ok, status: res.status, data }
}

export function die(msg: string): never {
  console.error(`\x1b[31mError:\x1b[0m ${msg}`)
  process.exit(1)
}
