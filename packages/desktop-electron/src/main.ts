import path from 'node:path'

import { app, BrowserWindow, dialog, shell } from 'electron'

import { RunnerSidecar, resolveLocalResourcesRoot } from './runner-sidecar'

let mainWindow: BrowserWindow | null = null
let sidecar: RunnerSidecar | null = null
let isQuitting = false

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.whenReady()
  .then(async () => {
    sidecar = new RunnerSidecar({
      resourcesRoot: app.isPackaged ? process.resourcesPath : resolveLocalResourcesRoot(__dirname),
      onUnexpectedExit: (message) => {
        dialog.showErrorBox('Coro runner stopped', message)
        if (!isQuitting) {
          void quitApplication()
        }
      },
    })

    const { launchSpec } = await sidecar.start()
    mainWindow = createMainWindow(launchSpec.urls.dashboard, launchSpec.urls.origin)
    await mainWindow.loadURL(launchSpec.urls.dashboard)
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    dialog.showErrorBox('Coro desktop failed to start', message)
    void quitApplication()
  })

app.on('activate', () => {
  if (!mainWindow && sidecar?.dashboardUrl() && sidecar.dashboardOrigin()) {
    mainWindow = createMainWindow(sidecar.dashboardUrl()!, sidecar.dashboardOrigin()!)
    void mainWindow.loadURL(sidecar.dashboardUrl()!)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void quitApplication()
  }
})

app.on('before-quit', (event) => {
  if (isQuitting) return
  event.preventDefault()
  void quitApplication()
})

function createMainWindow(dashboardUrl: string, dashboardOrigin: string): BrowserWindow {
  const preloadPath = path.join(__dirname, 'preload.js')
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    title: 'Coro',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(dashboardOrigin)) {
      return { action: 'allow' }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  window.webContents.on('will-navigate', (event, url) => {
    if (url === dashboardUrl || url.startsWith(dashboardOrigin)) return
    event.preventDefault()
    void shell.openExternal(url)
  })

  return window
}

async function quitApplication(): Promise<void> {
  if (isQuitting) return
  isQuitting = true
  try {
    await sidecar?.stop()
  } finally {
    app.quit()
  }
}