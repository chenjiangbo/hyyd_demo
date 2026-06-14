import { app, shell, BrowserWindow, Tray, Menu, nativeImage, ipcMain, clipboard, dialog, type MessageBoxReturnValue } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { CaptureSidecarClient } from './capture-sidecar-client'
import { loadRootEnv } from './runtime-env'
import { MaterialStore } from './material-store'
import { MaterialSyncWorker } from './material-sync'

loadRootEnv()

if (process.platform === 'win32') {
  app.disableHardwareAcceleration()
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let closePromptInFlight = false
const captureSidecar = new CaptureSidecarClient()
// 现场采集素材的本地落地 + 异步同步：粘贴→落 sqlite/文件→worker 上传后端
const materialStore = new MaterialStore()
const materialSync = new MaterialSyncWorker(materialStore)

type CloseBehavior = 'ask' | 'minimize' | 'quit'

interface WindowPreferences {
  closeBehavior: CloseBehavior
}

const DEFAULT_WINDOW_PREFS: WindowPreferences = {
  closeBehavior: 'ask'
}

function windowPrefsPath(): string {
  return join(app.getPath('userData'), 'window-preferences.json')
}

function readWindowPreferences(): WindowPreferences {
  const file = windowPrefsPath()
  if (!existsSync(file)) return DEFAULT_WINDOW_PREFS
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<WindowPreferences>
  if (parsed.closeBehavior === 'ask' || parsed.closeBehavior === 'minimize' || parsed.closeBehavior === 'quit') {
    return { closeBehavior: parsed.closeBehavior }
  }
  throw new Error(`窗口关闭偏好非法: ${String(parsed.closeBehavior)}`)
}

function writeWindowPreferences(prefs: WindowPreferences): void {
  if (prefs.closeBehavior !== 'ask' && prefs.closeBehavior !== 'minimize' && prefs.closeBehavior !== 'quit') {
    throw new Error(`窗口关闭偏好非法: ${String(prefs.closeBehavior)}`)
  }
  writeFileSync(windowPrefsPath(), JSON.stringify(prefs, null, 2), 'utf8')
}

function closeToTray(): void {
  mainWindow?.hide()
}

function quitApplication(): void {
  isQuitting = true
  app.quit()
}

async function requestWindowClose(): Promise<void> {
  if (closePromptInFlight) return
  const behavior = readWindowPreferences().closeBehavior
  if (behavior === 'minimize') {
    closeToTray()
    return
  }
  if (behavior === 'quit') {
    quitApplication()
    return
  }
  if (!mainWindow) return

  closePromptInFlight = true
  let result: MessageBoxReturnValue
  try {
    result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: '关闭智能寰宇',
      message: '关闭窗口时要退出应用，还是最小化到托盘？',
      detail: '最小化后应用会继续在托盘运行，采集功能也会继续工作。',
      buttons: ['最小化到托盘', '退出应用', '取消'],
      defaultId: 0,
      cancelId: 2,
      checkboxLabel: '记住我的选择',
      checkboxChecked: false,
      noLink: true
    })
  } finally {
    closePromptInFlight = false
  }

  if (result.checkboxChecked && result.response === 0) writeWindowPreferences({ closeBehavior: 'minimize' })
  if (result.checkboxChecked && result.response === 1) writeWindowPreferences({ closeBehavior: 'quit' })

  if (result.response === 0) closeToTray()
  if (result.response === 1) quitApplication()
}

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
    width: 1120,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    frame: false, // 去掉 Windows 原生标题栏，用 v2 自绘标题栏 + 窗口按钮
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

  // 关闭窗口时按用户偏好处理：首次询问，可记住最小化到托盘或直接退出。
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      void requestWindowClose()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 最大化/还原状态变化时通知渲染层，切换自绘按钮图标
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-changed', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-changed', false))

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 桌面应用加载 v2（新采集工具 UI）。v1 入口（index.html）保留作浏览器参考，不再在 Electron 里加载。
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/index-v2.html`)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index-v2.html'))
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

    // IPC: 关闭窗口（按偏好询问/最小化/退出）
    ipcMain.handle('window:request-close', () => requestWindowClose())
    ipcMain.handle('window:get-preferences', () => readWindowPreferences())
    ipcMain.handle('window:set-preferences', (_e, prefs: WindowPreferences) => {
      writeWindowPreferences(prefs)
      return readWindowPreferences()
    })
    ipcMain.on('window:hide', () => mainWindow?.hide())
    ipcMain.on('window:minimize', () => mainWindow?.minimize())
    ipcMain.on('window:maximize-toggle', () => {
      if (!mainWindow) return
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    })
    ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)
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
    // 【临时·采集调试页】最近原始帧（含结构化 messages/orderNo/conversationKind，不落库、仅内存）
    ipcMain.handle('capture:debug-frames', (_e, limit?: number) =>
      captureSidecar.listDebugFrames(limit ?? 60)
    )
    ipcMain.handle('capture:debug-clear', () => captureSidecar.clearDebugFrames())
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

    // ─── 现场采集素材 IPC ───
    // 粘贴落地后立即返回 view row（图片含 base64 dataURL），由渲染端追加进时间线，
    // 同时触发一次 sync tick，不必等下一个轮询间隔。
    ipcMain.handle('materials:add-text', (_e, orderId: number, text: string) => {
      const row = materialStore.addText(orderId, text)
      materialSync.kick()
      return row
    })
    ipcMain.handle('materials:add-image', (_e, orderId: number, dataUrl: string) => {
      const row = materialStore.addImage(orderId, dataUrl)
      materialSync.kick()
      return row
    })
    ipcMain.handle('materials:list', (_e, orderId: number) =>
      materialStore.listForOrder(orderId)
    )
    ipcMain.handle('materials:delete', (_e, id: number) => {
      materialStore.softDelete(id)
      materialSync.kick()
      return { id }
    })
    ipcMain.handle('materials:status', (_e, orderId?: number) =>
      materialStore.countByStatus(orderId)
    )
    ipcMain.handle('materials:retry-failed', () => {
      const n = materialStore.retryFailed()
      materialSync.kick()
      return { retried: n }
    })
    ipcMain.handle('materials:discard-failed', () => {
      const n = materialStore.discardFailed()
      return { discarded: n }
    })
    // 读 Electron 系统剪贴板。比 navigator.clipboard.read() 可靠得多：
    //   - 不要求 document focused（按钮点击就立刻能读）
    //   - 微信/企微截图复制的 DIB/BMP 格式 Electron 能正确解析成图片
    //   - 同时拿文本和图片，渲染端一次调用搞定
    ipcMain.handle('clipboard:read', () => {
      const text = clipboard.readText() || null
      const img = clipboard.readImage()
      const imageDataUrl = img.isEmpty() ? null : img.toDataURL()
      return { text, imageDataUrl }
    })

    // 渲染端把 backendUrl + employeeCode 推过来，worker 才会真上传。
    // 没设置前 worker 空转。
    ipcMain.handle(
      'materials:set-config',
      (_e, cfg: { backendUrl: string; employeeCode: string }) => {
        materialSync.setConfig(cfg)
        materialSync.kick()
        return { ok: true }
      }
    )
    ipcMain.handle(
      'capture:set-config',
      (_e, cfg: { backendUrl: string; employeeCode: string }) => {
        captureSidecar.setConfig(cfg)
        return { ok: true }
      }
    )

    createTray()
    createWindow()
    // sidecar 是订单生命周期沟通数据的核心来源；Windows 桌面端默认随应用启动。
    // 如需排障关闭，启动 app 前设环境变量 HYYD_ENABLE_SIDECAR=0。
    if (process.env.HYYD_ENABLE_SIDECAR !== '0') {
      captureSidecar.start().catch((error) => {
        console.error('[capture] failed to start sidecar', error)
      })
    } else {
      console.log('[capture] sidecar disabled (HYYD_ENABLE_SIDECAR=0)')
    }

    // 素材同步 worker：每 10s 扫一轮 pending/pending_delete
    materialSync.start()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else showMainWindow()
    })
  })

  app.on('before-quit', () => {
    isQuitting = true
    captureSidecar.stop()
    materialSync.stop()
  })

  // 注意：故意不监听 window-all-closed，让应用在托盘保持运行
}
