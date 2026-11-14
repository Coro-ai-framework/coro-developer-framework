// Mirror of `CoroDesktopApi` in packages/desktop-electron/src/preload.ts.
interface CoroDesktopApi {
  readonly isDesktopShell: true
  readonly platform: string
  readonly arch: string
  readonly electronVersion: string
  setAttentionCount(count: number): void
  notify(notification: { title: string; body: string; path: string }): void
  onNavigate(listener: (path: string) => void): () => void
}

interface Window {
  coroDesktop?: CoroDesktopApi
}
