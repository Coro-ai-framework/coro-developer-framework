// ── OAuth status normalisation ───────────────────────────────────────────────
//
// Maps Claude login manager states to the provider-agnostic OAuth status
// contract consumed by the dashboard GenericAuthPanel.

import type { ClaudeLoginState } from './login'

export type NormalizedOAuthStatus = {
  state: 'idle' | 'pending' | 'success' | 'error'
  authorizeUrl?: string
  userCode?: string
  account?: { label: string }
  message?: string
}

export function normalizeClaudeLoginStatus(state: ClaudeLoginState): NormalizedOAuthStatus {
  switch (state.status) {
    case 'idle':
      return { state: 'idle' }
    case 'authorizing':
      return {
        state: 'pending',
        authorizeUrl: state.automaticUrl ?? state.manualUrl,
      }
    case 'connected': {
      const email = state.account?.email
      const org = state.account?.organization
      const label = email ?? org ?? 'Connected'
      return {
        state: 'success',
        account: { label },
      }
    }
    case 'error':
      return {
        state: 'error',
        message: state.error ?? 'Claude login failed',
      }
    default:
      return { state: 'idle' }
  }
}
