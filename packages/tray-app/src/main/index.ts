import { app, shell, BrowserWindow, Tray, Menu, nativeImage, ipcMain, clipboard, dialog, screen, type MessageBoxReturnValue } from 'electron'
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { extname, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { CaptureSidecarClient } from './capture-sidecar-client'
import { loadRootEnv } from './runtime-env'
import { MaterialStore } from './material-store'
import { MaterialSyncWorker } from './material-sync'
import { setupReminderIPC } from './reminder-window'
import { PetIntakeService, type PetIntakeResult } from './pet-intake-service'
import { NativeChatCollectorManager, type NativeChatCollectorHealth, type CollectorHealthState, type NativePendingImageMatch } from './native-chat-collector-manager'
import { PetOrderAiService } from './pet-order-ai-service'

loadRootEnv()

// 应用显示名：否则 Windows 任务栏/托盘会显示默认 "Electron"
app.setName('寰宇智能助手')

// 保持旧版用户数据目录，避免应用改名后切换到新的空目录。
if (process.platform === 'win32') {
  app.setPath('userData', join(app.getPath('appData'), '智能寰宇'))
}

if (process.platform === 'win32') {
app.disableHardwareAcceleration()
app.setAppUserModelId('com.huanyu.trayapp')
}

let mainWindow: BrowserWindow | null = null
let petWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let closePromptInFlight = false
let isAuthenticated = false
let pendingPetCollectorNotice: { state: 'warning' | 'done'; message: string } | null = null
let pendingPetMobileStatus: PetMobileStatus | null = null
let pendingPetMobileReminder: string | null = null
let petNeedsOpenActive = false
let pendingPetOrderReminder: string | null = null
const pendingPetImageMatches = new Map<number, NativePendingImageMatch>()
let pendingPetPanel: { id: string; kind: string; [key: string]: unknown } | null = null
let petPanelSuspended = false
let petPanelChangedDuringSuspension = false
let lastPetBubbleSize: { width: number; height: number } | undefined
let lastPetOrderReminderKey: string | null = null
let wxworkCollectorNoticeActive: 'directory-missing' | 'not-installed' | null = null
const captureSidecar = new CaptureSidecarClient()
const nativeChatCollectors = new NativeChatCollectorManager()
// 现场采集素材的本地落地 + 异步同步：粘贴→落 sqlite/文件→worker 上传后端
const materialStore = new MaterialStore()
const materialSync = new MaterialSyncWorker(materialStore)
const petIntake = new PetIntakeService()
const petOrderAi = new PetOrderAiService(showPetPanel, updatePetPanel, hidePetPanel, undefined, suspendPetPanel, resumePetPanel, ensurePetPanelVisible, () => Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isFocused()))

function validPetPanel(value: unknown): value is { id: string; kind: string; [key: string]: unknown } {
  if (!value || typeof value !== 'object') return false
  const panel = value as Record<string, unknown>
  if (typeof panel.id !== 'string' || panel.id.length === 0 || panel.id.length > 120) return false
  if (panel.kind === 'speech' || panel.kind === 'progress' || panel.kind === 'error') return typeof panel.text === 'string'
  if (panel.kind === 'candidate-list') return typeof panel.title === 'string' && Array.isArray(panel.items)
  if (panel.kind !== 'form' || typeof panel.title !== 'string' || !Array.isArray(panel.fields) || !Array.isArray(panel.actions)) return false
  return panel.fields.every((field: unknown) => {
    if (!field || typeof field !== 'object') return false
    const item = field as Record<string, unknown>
    return typeof item.id === 'string' && typeof item.label === 'string' &&
      typeof item.type === 'string' && ['text', 'textarea', 'number', 'date', 'datetime-local', 'select', 'radio', 'checkbox'].includes(item.type) &&
      (typeof item.value === 'string' || typeof item.value === 'number' || typeof item.value === 'boolean')
  })
}

function showPetPanel(panel: unknown): void {
  if (!validPetPanel(panel)) throw new Error('浮动精灵面板数据非法或缺少 panelId')
  pendingPetPanel = panel
  petPanelSuspended = false
  petPanelChangedDuringSuspension = false
  petWindow?.webContents.send('pet:panel-show', panel)
  if (isAuthenticated) showPetWindow()
}

function updatePetPanel(id: string, panel: unknown): void {
  if (!validPetPanel(panel) || panel.id !== id || pendingPetPanel?.id !== id) {
    throw new Error('浮动精灵面板更新的 panelId 不匹配')
  }
  pendingPetPanel = panel
  if (petPanelSuspended) petPanelChangedDuringSuspension = true
  else petWindow?.webContents.send('pet:panel-show', panel)
}

function hidePetPanel(id?: string): void {
  if (!pendingPetPanel || (id && pendingPetPanel.id !== id)) return
  pendingPetPanel = null
  petPanelSuspended = false
  petPanelChangedDuringSuspension = false
  petWindow?.webContents.send('pet:panel-hide')
}

function suspendPetPanel(id: string): void {
  if (pendingPetPanel?.id !== id || petPanelSuspended) return
  petPanelSuspended = true
  petPanelChangedDuringSuspension = false
  petWindow?.webContents.send('pet:panel-visibility', false)
}

function resumePetPanel(id: string): void {
  if (pendingPetPanel?.id !== id || !petPanelSuspended) return
  petPanelSuspended = false
  if (petPanelChangedDuringSuspension) petWindow?.webContents.send('pet:panel-show', pendingPetPanel)
  else petWindow?.webContents.send('pet:panel-visibility', true)
  petPanelChangedDuringSuspension = false
  ensurePetPanelVisible(id)
}

function ensurePetPanelVisible(id: string): void {
  if (!isAuthenticated || petPanelSuspended || pendingPetPanel?.id !== id) return
  showPetWindow()
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])
const PET_IDLE_SIZE = { width: 80, height: 80 }
const PET_SPEAKING_SIZE = { width: 240, height: 220 }
const PET_CHARACTER_SIZE = { width: 56, height: 61 }
type PetBubbleSide = 'left' | 'right'
type PetMobileStatus = { state: 'online' | 'stale' | 'unknown'; lastSeenAt: string | null }
let petBubbleSide: PetBubbleSide = 'left'

function writePetDiagnostic(event: string, data: unknown = null): void {
  const row = { at: new Date().toISOString(), event, data }
  try {
    appendFileSync(join(app.getPath('userData'), 'pet-diagnostics.jsonl'), `${JSON.stringify(row)}\n`, 'utf8')
  } catch (error) {
    console.error('[pet-diagnostics] 写入失败', error)
  }
}

type CloseBehavior = 'ask' | 'minimize' | 'quit'

interface WindowPreferences {
  closeBehavior: CloseBehavior
}

const DEFAULT_WINDOW_PREFS: WindowPreferences = {
  closeBehavior: 'minimize'
}

function windowPrefsPath(): string {
  return join(app.getPath('userData'), 'window-preferences.json')
}

function readWindowPreferences(): WindowPreferences {
  const file = windowPrefsPath()
  if (!existsSync(file)) return DEFAULT_WINDOW_PREFS
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<WindowPreferences>
    if (parsed.closeBehavior === 'minimize' || parsed.closeBehavior === 'quit') {
      return { closeBehavior: parsed.closeBehavior }
    }
  } catch {
    // 忽略异常，降级回默认设置
  }
  return DEFAULT_WINDOW_PREFS
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

function ensureAutoLaunchEnabled(): void {
  if (process.platform !== 'win32' || is.dev) return

  const settings = {
    openAtLogin: true,
    path: process.execPath,
    args: ['--hidden']
  }

  app.setLoginItemSettings(settings)
  const current = app.getLoginItemSettings({
    path: settings.path,
    args: settings.args
  })

  if (!current.openAtLogin) {
    throw new Error('注册 Windows 开机自启失败')
  }
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
      title: '关闭寰宇智能助手',
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

function raisePetWindow(): void {
  if (!petWindow || petWindow.isDestroyed()) return
  petWindow.setAlwaysOnTop(true, 'screen-saver')
  petWindow.moveTop()
}

function showPetWindow(): void {
  if (!petWindow || petWindow.isDestroyed()) {
    createPetWindow()
    return
  }
  petWindow.showInactive()
  raisePetWindow()
}

function activateClient(): void {
  if (isAuthenticated) showPetWindow()
  else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
  }
}

function switchServer(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow()
  const window = mainWindow
  if (!window || window.isDestroyed()) return

  const showLogin = (): void => {
    if (window.isDestroyed()) return
    window.show()
    window.focus()
    void window.webContents.executeJavaScript(`
      localStorage.removeItem('hyyd.v2.employeeCode')
      localStorage.removeItem('hyyd.v2.displayName')
      window.location.reload()
    `).catch((error: unknown) => {
      console.error('[client] 切换服务器时清除登录状态失败', error)
    })
  }

  if (window.webContents.isLoading()) {
    window.webContents.once('did-finish-load', showLogin)
  } else {
    showLogin()
  }
}

function createPetWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) return

  writePetDiagnostic('window:create')

  petWindow = new BrowserWindow({
    width: PET_IDLE_SIZE.width,
    height: PET_IDLE_SIZE.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    movable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false
    }
  })

  raisePetWindow()
  petWindow.on('show', raisePetWindow)
  petWindow.setMenuBarVisibility(false)
  petWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/www\.haodf\.com\/(hospital|doctor)\/\d+\.html$/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  petWindow.webContents.on('context-menu', (event) => {
    event.preventDefault()
    if (!petWindow || petWindow.isDestroyed()) return
    const contextMenu = Menu.buildFromTemplate([
      { label: '隐藏浮动精灵', click: () => petWindow?.hide() },
      { type: 'separator' },
      { label: '退出客户端', click: quitApplication }
    ])
    contextMenu.popup({ window: petWindow })
  })
  petWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    writePetDiagnostic('renderer:console', { level, message, line, sourceId })
  })
  petWindow.on('closed', () => { petWindow = null })
  petWindow.webContents.on('did-finish-load', () => {
    if (!petWindow || petWindow.isDestroyed()) return
    if (pendingPetCollectorNotice) {
      petWindow.webContents.send('pet:status', pendingPetCollectorNotice)
      pendingPetCollectorNotice = null
    }
    if (pendingPetMobileStatus) petWindow.webContents.send('pet:mobile-status', pendingPetMobileStatus)
    if (pendingPetPanel) {
      petWindow.webContents.send('pet:panel-show', pendingPetPanel)
      if (petPanelSuspended) petWindow.webContents.send('pet:panel-visibility', false)
    }
    if (pendingPetMobileReminder) {
      petWindow.webContents.send('pet:mobile-reminder', pendingPetMobileReminder)
      pendingPetMobileReminder = null
    }
    if (pendingPetOrderReminder) {
      petWindow.webContents.send('pet:mobile-reminder', pendingPetOrderReminder)
      pendingPetOrderReminder = null
    }
    for (const match of pendingPetImageMatches.values()) petWindow.webContents.send('pet:image-match', match)
  })
  petWindow.once('ready-to-show', () => {
    const display = screen.getPrimaryDisplay()
    const area = display.workArea
    petWindow?.setPosition(area.x + area.width - PET_IDLE_SIZE.width - 24, area.y + 24)
    showPetWindow()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    petWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/pet.html`)
  } else {
    petWindow.loadFile(join(__dirname, '../renderer/pet.html'))
  }
}

function resizePetWindow(expanded: boolean, bubbleSize?: { width: number; height: number }): { bubbleSide: PetBubbleSide } {
  if (!petWindow || petWindow.isDestroyed()) throw new Error('浮动精灵窗口尚未创建')
  if (bubbleSize) lastPetBubbleSize = bubbleSize

  const bounds = petWindow.getBounds()
  const wasExpanded = bounds.width > PET_IDLE_SIZE.width || bounds.height > PET_IDLE_SIZE.height
  const currentCharacterLeft = wasExpanded ? (petBubbleSide === 'left' ? bounds.width - 68 : 12) : 12
  const currentCharacterTop = wasExpanded ? bounds.height - 75 : 9
  const characterAnchorX = bounds.x + currentCharacterLeft + PET_CHARACTER_SIZE.width / 2
  const characterAnchorY = bounds.y + currentCharacterTop + PET_CHARACTER_SIZE.height / 2
  // Match the monitor to the mascot's anchor point. An expanded window may
  // overlap multiple monitors, making getDisplayMatching(bounds) choose the
  // wrong work area and clamp the panel off the visible screen.
  const display = screen.getDisplayNearestPoint({ x: Math.round(characterAnchorX), y: Math.round(characterAnchorY) })
  const area = display.workArea
  const target = expanded
    ? (() => {
        const measuredWidth = (bubbleSize ?? lastPetBubbleSize)?.width ?? PET_SPEAKING_SIZE.width - 36
        const measuredHeight = (bubbleSize ?? lastPetBubbleSize)?.height ?? 240
        return {
          width: Math.max(PET_SPEAKING_SIZE.width, Math.ceil(measuredWidth + 120)),
          height: Math.max(PET_SPEAKING_SIZE.height, Math.ceil(measuredHeight + 60))
        }
      })()
    : PET_IDLE_SIZE

  // Keep the entire expanded panel inside the monitor's work area. The pet is
  // often parked near the top edge; anchoring it at the bottom can otherwise
  // place the panel window at a negative Y coordinate.
  const targetWidth = Math.min(target.width, area.width)
  const targetHeight = Math.min(target.height, area.height)

  if (expanded && !wasExpanded) {
    petBubbleSide = characterAnchorX > area.x + area.width / 2 ? 'left' : 'right'
  }

  const targetCharacterLeft = expanded ? (petBubbleSide === 'left' ? targetWidth - 68 : 12) : 12
  const targetCharacterTop = expanded ? targetHeight - 75 : 9
  const x = Math.round(characterAnchorX - targetCharacterLeft - PET_CHARACTER_SIZE.width / 2)
  const y = Math.round(characterAnchorY - targetCharacterTop - PET_CHARACTER_SIZE.height / 2)
  const clampedX = Math.max(area.x, Math.min(x, area.x + area.width - targetWidth))
  const clampedY = Math.max(area.y, Math.min(y, area.y + area.height - targetHeight))
  const nextBounds = { x: clampedX, y: clampedY, width: targetWidth, height: targetHeight }
  if (bounds.x !== nextBounds.x || bounds.y !== nextBounds.y || bounds.width !== nextBounds.width || bounds.height !== nextBounds.height) petWindow.setBounds(nextBounds, false)
  writePetDiagnostic('window:resize', { expanded, side: petBubbleSide, before: bounds, anchor: { x: characterAnchorX, y: characterAnchorY }, workArea: area, after: petWindow.getBounds() })
  return { bubbleSide: petBubbleSide }
}

// 登录态用小窗（聚焦工号输入），登录后放大到工作台尺寸。两套尺寸都居中显示。
const LOGIN_SIZE = { width: 960, height: 640 }
const MAIN_SIZE = { width: 1320, height: 880 }

function applyWindowStage(stage: 'login' | 'main'): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMaximized()) return // 用户已手动最大化则不打扰
  const size = stage === 'main' ? MAIN_SIZE : LOGIN_SIZE
  mainWindow.setSize(size.width, size.height, true)
  mainWindow.center()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: LOGIN_SIZE.width,
    height: LOGIN_SIZE.height,
    minWidth: 760,
    minHeight: 560,
    show: false,
    frame: false, // 去掉 Windows 原生标题栏，用 v2 自绘标题栏 + 窗口按钮
    autoHideMenuBar: true,
    title: '寰宇智能助手',
    icon, // Windows 任务栏/窗口图标（否则显示 Electron 默认图标）
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false
    }
  })

  // 开发时显示工作台，便于调试和复用现有客户端页面；正式版继续保持已登录后托盘驻留。
  if (is.dev) {
    mainWindow.once('ready-to-show', () => {
      mainWindow?.show()
      mainWindow?.focus()
    })
  }

  // v2 renderer 根据是否存在登录会话决定显示登录窗口还是继续隐藏工作台。
  // 这样已有会话的开机自启只留下托盘和浮动精灵。

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
  tray.setToolTip('寰宇智能助手')
  nativeChatCollectors.setStatusListener(updateCollectorTrayStatus)
  nativeChatCollectors.setImageMatchListener((match) => {
    pendingPetImageMatches.set(match.attachmentId, match)
    if (petWindow && !petWindow.isDestroyed() && !petWindow.webContents.isLoading()) {
      petWindow.webContents.send('pet:image-match', match)
    }
  })
  updateCollectorTrayStatus(nativeChatCollectors.getHealth())
  tray.on('click', activateClient)
  tray.on('double-click', activateClient)
}

function collectorStateLabel(state: CollectorHealthState): string {
  switch (state) {
    case 'running': return '正常'
    case 'starting': return '启动中'
    case 'waiting': return '等待启动'
    case 'error': return '异常'
  }
}

function updateCollectorTrayStatus(status: NativeChatCollectorHealth): void {
  if (!tray || tray.isDestroyed()) return
  const directoryMissing = status.wxwork.detail.startsWith('未检测到当前企微的数据目录')
    || status.wxwork.detail.startsWith('发现多个有效的企微数据目录')
  const notice = directoryMissing
    ? { key: 'directory-missing' as const, message: '未检测到当前企微的数据目录。' }
    : status.wxwork.detail.startsWith('未安装企业微信')
      ? { key: 'not-installed' as const, message: '当前未安装企业微信，企微消息不会采集。' }
      : null
  if (notice && wxworkCollectorNoticeActive !== notice.key) {
    wxworkCollectorNoticeActive = notice.key
    pendingPetCollectorNotice = { state: 'warning', message: notice.message }
    if (petWindow && !petWindow.isDestroyed() && !petWindow.webContents.isLoading()) {
      petWindow.webContents.send('pet:status', pendingPetCollectorNotice)
      pendingPetCollectorNotice = null
    }
  } else if (status.wxwork.state === 'running' && wxworkCollectorNoticeActive) {
    wxworkCollectorNoticeActive = null
    pendingPetCollectorNotice = { state: 'done', message: '已找到企微数据目录，消息采集已启动。' }
    if (petWindow && !petWindow.isDestroyed() && !petWindow.webContents.isLoading()) {
      petWindow.webContents.send('pet:status', pendingPetCollectorNotice)
      pendingPetCollectorNotice = null
    }
  }
  tray.setToolTip(`寰宇医道 · 微信采集${collectorStateLabel(status.wechat.state)} · 企微采集${collectorStateLabel(status.wxwork.state)}`)
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示浮动精灵', click: showPetWindow },
    { label: '切换服务器', click: switchServer },
    { type: 'separator' },
    { label: `微信消息采集：${collectorStateLabel(status.wechat.state)}`, enabled: false },
    { label: `企微消息采集：${collectorStateLabel(status.wxwork.state)}`, enabled: false },
    { label: '打开消息采集日志', click: () => {
      void nativeChatCollectors.openLog().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        dialog.showErrorBox('无法打开消息采集日志', message)
      })
    } },
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

}

// 单实例锁：第二次启动只显示浮动精灵，不打开工作台。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', activateClient)

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
    // 仅未登录时由渲染层主动显示登录窗；已登录时工作台保持隐藏。
    ipcMain.on('window:show', () => mainWindow?.show())
    ipcMain.on('window:hide', () => mainWindow?.hide())
    ipcMain.on('session:set-authenticated', (_e, value: unknown) => {
      isAuthenticated = value === true
      if (!isAuthenticated) petOrderAi.setConfig({ backendUrl: '', employeeCode: '' })
    })
    ipcMain.on('window:minimize', () => mainWindow?.minimize())
    ipcMain.on('window:maximize-toggle', () => {
      if (!mainWindow) return
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      else mainWindow.maximize()
    })
    ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)
    // 登录态/工作台态切换窗口尺寸（渲染层根据是否已登录调用）
    ipcMain.on('window:set-stage', (_e, stage: 'login' | 'main') => applyWindowStage(stage))
    ipcMain.on('app:quit', () => {
      isQuitting = true
      app.quit()
    })
    ipcMain.on('pet:hide', () => petWindow?.hide())
    ipcMain.handle('pet:panel-show', (_e, panel: unknown) => showPetPanel(panel))
    ipcMain.handle('pet:panel-current', () => pendingPetPanel)
    ipcMain.handle('pet:panel-update', (_e, id: string, panel: unknown) => updatePetPanel(id, panel))
    ipcMain.handle('pet:panel-hide', () => hidePetPanel())
    ipcMain.handle('pet:order-dictionary', (_e, kind: string, query?: string, parent?: { hospitalId?: string; departmentId?: string; currentId?: string }) =>
      petOrderAi.dictionary(kind, query, parent))
    ipcMain.on('pet:panel-action', (_e, event: unknown) => {
      if (!event || typeof event !== 'object') throw new Error('浮动精灵操作事件非法')
      const value = event as { panelId?: unknown; actionId?: unknown; fields?: unknown }
      if (value.panelId !== pendingPetPanel?.id || typeof value.actionId !== 'string') throw new Error('浮动精灵操作事件的 panelId 无效')
      if (typeof value.panelId === 'string' && value.panelId.startsWith('order-ai:')) {
        void petOrderAi.handlePanelAction(value.panelId, value.actionId, value.fields && typeof value.fields === 'object'
          ? value.fields as Record<string, unknown> : {}).catch((error) => {
          console.error('[pet-order-ai] 面板操作失败', error)
        })
      } else {
        mainWindow?.webContents.send('pet:panel-action', event)
      }
    })
    ipcMain.on('pet:debug-log', (_e, payload: unknown) => {
      if (!payload || typeof payload !== 'object') throw new Error('浮动精灵诊断日志非法')
      writePetDiagnostic('renderer:event', payload)
    })
    ipcMain.on('pet:order-reminder', (_e, payload: unknown) => {
      if (!payload || typeof payload !== 'object') throw new Error('订单提醒数据非法')
      const value = payload as { key?: unknown; message?: unknown }
      if (typeof value.key !== 'string' || value.key.length === 0 || typeof value.message !== 'string' || value.message.length === 0) {
        throw new Error('订单提醒数据非法')
      }
      if (value.key === lastPetOrderReminderKey) return
      lastPetOrderReminderKey = value.key
      pendingPetOrderReminder = value.message
      petWindow?.webContents.send('pet:mobile-reminder', value.message)
      writePetDiagnostic('order-reminder', { key: value.key })
    })
    ipcMain.on('pet:mobile-status', (_e, status: unknown) => {
      if (!status || typeof status !== 'object') throw new Error('移动端状态非法')
      const value = status as { state?: unknown; lastSeenAt?: unknown; needsOpen?: unknown }
      if (value.state !== 'online' && value.state !== 'stale' && value.state !== 'unknown') throw new Error('移动端心跳状态非法')
      if (value.lastSeenAt !== null && typeof value.lastSeenAt !== 'string') throw new Error('移动端最近心跳时间非法')
      if (typeof value.needsOpen !== 'boolean') throw new Error('移动端提醒状态非法')

      const nextStatus: PetMobileStatus = { state: value.state, lastSeenAt: value.lastSeenAt }
      pendingPetMobileStatus = nextStatus
      petWindow?.webContents.send('pet:mobile-status', nextStatus)
      if (value.needsOpen && !petNeedsOpenActive) {
        petNeedsOpenActive = true
        const message = '手机 App 好像有一会儿没联系我了，打开一下 App，我才能继续收到资料哦。'
        pendingPetMobileReminder = message
        petWindow?.webContents.send('pet:mobile-reminder', message)
      } else if (!value.needsOpen) {
        petNeedsOpenActive = false
        pendingPetMobileReminder = null
      }
    })
    ipcMain.handle('pet:get-bounds', () => petWindow?.getBounds() ?? null)
    ipcMain.on('pet:move', (_e, x: unknown, y: unknown) => {
      if (!petWindow || petWindow.isDestroyed()) return
      if (typeof x !== 'number' || !Number.isInteger(x) || typeof y !== 'number' || !Number.isInteger(y)) {
        throw new Error('浮动精灵位置非法')
      }
      const before = petWindow.getPosition()
      petWindow.setPosition(x, y)
      writePetDiagnostic('window:move', { before, after: [x, y] })
    })
    ipcMain.handle('pet:set-expanded', (_e, expanded: unknown): { bubbleSide: PetBubbleSide } => {
      if (typeof expanded !== 'boolean') throw new Error('浮动精灵展开状态非法')
      return resizePetWindow(expanded)
    })
    ipcMain.handle('pet:set-bubble-size', (_e, size: unknown): { bubbleSide: PetBubbleSide } => {
      if (!size || typeof size !== 'object') throw new Error('浮动精灵气泡尺寸非法')
      const value = size as { width?: unknown; height?: unknown }
      if (typeof value.width !== 'number' || !Number.isFinite(value.width) || value.width <= 0 || typeof value.height !== 'number' || !Number.isFinite(value.height) || value.height <= 0) {
        throw new Error('浮动精灵气泡尺寸非法')
      }
      return resizePetWindow(true, { width: Math.ceil(value.width), height: Math.ceil(value.height) })
    })
    ipcMain.handle('pet:drop-files', async (_e, paths: unknown): Promise<PetIntakeResult> => {
      if (!Array.isArray(paths) || paths.length === 0) {
        return { state: 'unknown', message: '嗯…我没有接到文件' }
      }
      if (paths.length !== 1 || typeof paths[0] !== 'string') {
        return { state: 'unknown', message: '一次先给我一张图片吧' }
      }
      const filePath = paths[0]
      try {
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          return { state: 'unknown', message: '这个文件已经找不到了' }
        }
      } catch (error) {
        console.error('[pet] 读取拖入文件失败', error)
        return { state: 'unknown', message: '这个文件现在读不到，我再试一次吧' }
      }
      if (!IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase())) {
        return { state: 'unknown', message: '嗯…这个文件我暂时还不会处理' }
      }
      try {
        const result = await petIntake.processFile(filePath)
        petWindow?.webContents.send('pet:status', result)
        return result
      } catch (error) {
        const message = (error as Error).message
        console.error('[pet] 图片处理失败', error)
        const result = { state: 'unknown' as const, message: `这张图片处理失败了：${message}` }
        petWindow?.webContents.send('pet:status', result)
        return result
      }
    })
    ipcMain.handle('pet:select-order', async (_e, payload: unknown): Promise<PetIntakeResult> => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('订单确认内容无效')
      const value = payload as { orderId?: unknown; applicationNo?: unknown }
      if (typeof value.orderId !== 'number' || !Number.isSafeInteger(value.orderId)
        || !(value.applicationNo === undefined || (typeof value.applicationNo === 'string' && value.applicationNo.trim()))) throw new Error('订单确认信息不完整')
      const result = await petIntake.selectOrder(value.orderId, typeof value.applicationNo === 'string' ? value.applicationNo.trim() : undefined)
      petWindow?.webContents.send('pet:status', result)
      return result
    })
    ipcMain.handle('pet:discard-pending-image', (): void => {
      petIntake.discardPending()
    })
    ipcMain.handle('pet:resolve-native-image-match', async (_e, payload: unknown) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('图片匹配确认内容无效')
      const value = payload as { attachmentId?: unknown; applicationNo?: unknown; orderId?: unknown }
      if (typeof value.attachmentId !== 'number' || !Number.isSafeInteger(value.attachmentId)
        || typeof value.applicationNo !== 'string' || !value.applicationNo.trim()
        || !(value.orderId === null || value.orderId === undefined || (typeof value.orderId === 'number' && Number.isSafeInteger(value.orderId)))) {
        throw new Error('图片匹配确认字段无效')
      }
      await nativeChatCollectors.resolveImageMatch(value.attachmentId, value.applicationNo, value.orderId == null ? null : value.orderId)
      pendingPetImageMatches.delete(value.attachmentId)
      const result = { state: 'done' as const, message: value.orderId == null ? '图片已关联到申领号' : '图片已关联到对应订单' }
      petWindow?.webContents.send('pet:status', result)
      return result
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
    // 调试：选一张本地 PNG，返回路径（取消返回 null）
    ipcMain.handle('capture:pick-image', async () => {
      const r = await dialog.showOpenDialog({
        title: '选择要测试的聊天截图',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp'] }]
      })
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
    })
    // 调试：对上传图片跑一次完整结构化，结果注入调试帧缓冲
    ipcMain.handle('capture:run-on-image', (_e, imagePath: string, channel?: string) =>
      captureSidecar.runOnImage(imagePath, channel ?? 'wxwork')
    )
    ipcMain.handle('capture:diag-logs', (_e, limit?: number) => captureSidecar.listDiagLog(limit))
    ipcMain.handle('capture:diag-clear', () => captureSidecar.clearDiagLog())
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
        petIntake.setConfig(cfg)
        petOrderAi.setConfig(cfg)
        materialSync.kick()
        return { ok: true }
      }
    )
    ipcMain.handle(
      'capture:set-config',
      (_e, cfg: { backendUrl: string; employeeCode: string }) => {
        nativeChatCollectors.setConfig(cfg)
        return { ok: true }
      }
    )
    // 现场验证开关：是否保存采集调试数据（截图 + .debug.json）。切换会重启 sidecar 生效。
    ipcMain.handle('capture:set-save-debug', (_e, value: boolean) =>
      captureSidecar.setSaveDebug(!!value)
    )

    ensureAutoLaunchEnabled()
    createTray()
    createWindow()
    createPetWindow()
    petOrderAi.start()
    setupReminderIPC()

    // 截图采集保留用于历史排障入口，但不再自动启动；会话消息由本机原生读取子进程采集。

    // 素材同步 worker：每 10s 扫一轮 pending/pending_delete
    materialSync.start()

    app.on('activate', activateClient)
  })

  app.on('before-quit', () => {
    isQuitting = true
    petWindow?.close()
    captureSidecar.stop()
    nativeChatCollectors.stop()
    materialSync.stop()
    petOrderAi.stop()
  })

  // 注意：故意不监听 window-all-closed，让应用在托盘保持运行
}
