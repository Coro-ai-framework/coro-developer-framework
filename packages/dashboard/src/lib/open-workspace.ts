import { jsonRequest, requestJson } from './http'

// ── Open-in-editor API ───────────────────────────────────────────────────────
//
// Mirrors the runner's `GET /system/editors` + `POST /jobs/:id/open`. Both are
// local-mode only; in hybrid mode the editors list comes back empty and the UI
// hides the affordance.

export interface EditorInfo {
  id: string
  name: string
}

export interface EditorsResponse {
  mode: 'local' | 'hybrid'
  editors: EditorInfo[]
}

export async function fetchEditors(): Promise<EditorsResponse> {
  return requestJson<EditorsResponse>('/system/editors')
}

export interface OpenWorkspaceResult {
  ok: boolean
  target: 'editor' | 'folder'
  editor?: EditorInfo
  path: string
}

export async function openJobWorkspace(
  jobId: string,
  body: { target: 'editor' | 'folder'; editor?: string },
): Promise<OpenWorkspaceResult> {
  return requestJson<OpenWorkspaceResult>(`/jobs/${jobId}/open`, jsonRequest(body, { method: 'POST' }))
}
