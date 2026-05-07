import path from 'node:path'

import { app, BrowserWindow, dialog, shell, type MessageBoxOptions } from 'electron'
import { autoUpdater, type UpdateDownloadedEvent } from 'electron-updater'

import { RunnerSidecar, resolveLocalResourcesRoot } from './runner-sidecar'

let mainWindow: BrowserWindow | null = null
let sidecar: RunnerSidecar | null = null
let isQuitting = false
let isInstallingUpdate = false
let didPromptForDownloadedUpdate = false

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
    startAutoUpdater()
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
  if (isInstallingUpdate) {
    isQuitting = true
    logAutoUpdater('Preparing runner shutdown for update install')
    void sidecar?.stop().catch((error) => {
      logAutoUpdater('Failed to stop runner before update quit', serializeError(error))
    })
    return
  }
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

function startAutoUpdater(): void {
  if (!app.isPackaged || process.mas) {
    logAutoUpdater('Skipping updater for unpackaged or MAS build', {
      isPackaged: app.isPackaged,
      isMas: process.mas,
    })
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    logAutoUpdater('Checking for updates')
  })

  autoUpdater.on('update-available', (info) => {
    logAutoUpdater('Update available', {
      version: info.version,
      releaseDate: info.releaseDate,
    })
  })

  autoUpdater.on('update-not-available', (info) => {
    logAutoUpdater('No update available', {
      version: info.version,
    })
  })

  autoUpdater.on('download-progress', (progress) => {
    logAutoUpdater('Downloading update', {
      percent: Number(progress.percent.toFixed(1)),
      bytesPerSecond: progress.bytesPerSecond,
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    logAutoUpdater('Update downloaded', {
      version: info.version,
      downloadedFile: info.downloadedFile,
    })
    void promptToInstallDownloadedUpdate(info)
  })

  autoUpdater.on('error', (error) => {
    logAutoUpdater('Updater error', serializeError(error))
  })

  void autoUpdater.checkForUpdates().catch((error) => {
    logAutoUpdater('checkForUpdates failed', serializeError(error))
  })
}

async function promptToInstallDownloadedUpdate(info: UpdateDownloadedEvent): Promise<void> {
  if (didPromptForDownloadedUpdate || isInstallingUpdate) return

  didPromptForDownloadedUpdate = true
  const messageBoxOptions: MessageBoxOptions = {
    type: 'info',
    buttons: ['Restart and Install', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: 'Coro update ready',
    detail: `Coro ${info.version} has been downloaded. Restart now to install it, or keep working and it will install automatically when you quit the app.`,
  }

  const messageBoxResult = mainWindow
    ? await dialog.showMessageBox(mainWindow, messageBoxOptions)
    : await dialog.showMessageBox(messageBoxOptions)

  if (messageBoxResult.response === 0) {
    await installDownloadedUpdate()
  }
}

async function installDownloadedUpdate(): Promise<void> {
  if (isInstallingUpdate) return

  isInstallingUpdate = true
  logAutoUpdater('Installing downloaded update and restarting')

  try {
    autoUpdater.quitAndInstall(false, true)
  } catch (error) {
    isInstallingUpdate = false
    didPromptForDownloadedUpdate = false
    const message = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox('Coro update failed', message)
  }
}

function logAutoUpdater(message: string, details?: unknown): void {
  if (details === undefined) {
    console.info(`[desktop:update] ${message}`)
    return
  }

  console.info(`[desktop:update] ${message}`, details)
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message
  }

  return String(error)
}