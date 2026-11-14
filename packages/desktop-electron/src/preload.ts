import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

export interface CoroDesktopNotification {
  title: string
  body: string
  /** Dashboard route to open when the notification is clicked, e.g. `/plans/abc?run=job-1`. */
  path: string
}

export interface CoroDesktopApi {
  readonly isDesktopShell: true
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly electronVersion: string
  /** Dock / taskbar badge: how many items need the developer. */
  setAttentionCount(count: number): void
  notify(notification: CoroDesktopNotification): void
  /** Called with a dashboard route when a notification is clicked. Returns an unsubscribe. */
  onNavigate(listener: (path: string) => void): () => void
}

const desktopApi: CoroDesktopApi = {
  isDesktopShell: true,
  platform: process.platform,
  arch: process.arch,
  electronVersion: process.versions.electron,
  setAttentionCount(count) {
    ipcRenderer.send('coro:attention-count', count)
  },
  notify(notification) {
    ipcRenderer.send('coro:notify', notification)
  },
  onNavigate(listener) {
    const handler = (_event: IpcRendererEvent, path: unknown) => {
      if (typeof path === 'string') listener(path)
    }
    ipcRenderer.on('coro:navigate', handler)
    return () => {
      ipcRenderer.removeListener('coro:navigate', handler)
    }
  },
}

contextBridge.exposeInMainWorld('coroDesktop', desktopApi)

declare global {
  interface Window {
    coroDesktop?: CoroDesktopApi
  }
}
