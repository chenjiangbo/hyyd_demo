import { app, shell, BrowserWindow, Tray, Menu, nativeImage, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { CaptureSidecarClient } from './capture-sidecar-client'
import { loadRootEnv } from './runtime-env'

loadRootEnv()

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
const captureSidecar = new CaptureSidecarClient()

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  createWindow()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: '寰宇医道 - 采集工作台',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 关闭窗口时只隐藏（除非从托盘选择"退出"）
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  const image = nativeImage.createFromPath(icon)
  // Windows 任务栏托盘标准 16x16
  const trayImage = image.resize({ width: 16, height: 16 })
  tray = new Tray(trayImage)
  tray.setToolTip('寰宇医道采集客户端')

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示工作台', click: showMainWindow },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(contextMenu)

  // 单击图标显示主窗口（macOS 默认双击）
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
}

// 单实例锁：第二次启动直接拉起已有窗口
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showMainWindow)

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.huanyu.collector')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // IPC: 关闭窗口（仅隐藏）
    ipcMain.on('window:hide', () => mainWindow?.hide())
    ipcMain.on('window:minimize', () => mainWindow?.minimize())
    ipcMain.on('app:quit', () => {
      isQuitting = true
      app.quit()
    })
    ipcMain.handle('capture:status', () => captureSidecar.getStatus())
    ipcMain.handle('capture:conversations', (_e, channel?: string) =>
      captureSidecar.listConversations(channel)
    )
    ipcMain.handle('capture:messages', (_e, threadId: number) =>
      captureSidecar.listMessages(threadId)
    )
    // 调试用
    ipcMain.handle('capture:frames', (_e, channel?: string, limit?: number) =>
      captureSidecar.listFrames(channel, limit ?? 30)
    )
    ipcMain.handle('capture:layout', (_e, id: number) => captureSidecar.getLayout(id))
    ipcMain.handle('capture:screenshot', (_e, path: string) =>
      captureSidecar.readScreenshotDataUrl(path)
    )
    // 截图验证：直接从磁盘列出 sidecar 存下的原始 PNG
    ipcMain.handle('capture:shots', (_e, channel?: string, limit?: number) =>
      captureSidecar.listShots(channel, limit ?? 30)
    )
    ipcMain.handle('capture:clear-shots', () => captureSidecar.clearShots())
    // AI 还原验证：把选中关键帧发给多个模型还原消息
    ipcMain.handle(
      'capture:ai-reconstruct',
      (
        _e,
        inputs: Array<{ path: string; capturedAt: string | null }>,
        models?: string[],
        channel?: string
      ) => captureSidecar.reconstructAi(inputs, models, channel)
    )

    createTray()
    createWindow()
    captureSidecar.start().catch((error) => {
      console.error('[capture] failed to start sidecar', error)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showMainWindow()
    })
  })

  app.on('before-quit', () => {
    isQuitting = true
    captureSidecar.stop()
  })

  // 注意：故意不监听 window-all-closed，让应用在托盘保持运行
}
