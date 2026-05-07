import { contextBridge } from 'electron'

export interface CoroDesktopApi {
  readonly isDesktopShell: true
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly electronVersion: string
}

const desktopApi: CoroDesktopApi = {
  isDesktopShell: true,
  platform: process.platform,
  arch: process.arch,
  electronVersion: process.versions.electron,
}

contextBridge.exposeInMainWorld('coroDesktop', desktopApi)

declare global {
  interface Window {
    coroDesktop?: CoroDesktopApi
  }
}