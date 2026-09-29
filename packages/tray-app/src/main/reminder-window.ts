import { BrowserWindow, screen, ipcMain } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

const DEFAULT_WIDTH = 380
const DEFAULT_HEIGHT = 270
const MARGIN = 16

let reminderWindow: BrowserWindow | null = null
let currentReminderData: unknown = null

export function getReminderWindow(): BrowserWindow | null {
  return reminderWindow
}

export function positionReminderWindow(
  win: BrowserWindow,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT
): void {
  try {
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenW, height: screenH, x, y } = primaryDisplay.workArea
    const posX = Math.round(x + screenW - width - MARGIN)
    const posY = Math.round(y + screenH - height - MARGIN)
    win.setBounds({ x: posX, y: posY, width, height })
  } catch (err) {
    console.error('[reminder-window] failed to position window:', err)
  }
}

export function createReminderWindow(): BrowserWindow {
  if (reminderWindow && !reminderWindow.isDestroyed()) {
    return reminderWindow
  }

  reminderWindow = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    useContentSize: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      backgroundThrottling: false
    }
  })

  reminderWindow.setAlwaysOnTop(true, 'screen-saver')

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    reminderWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/index-v2.html?view=desktop-reminder`)
  } else {
    reminderWindow.loadFile(join(__dirname, '../renderer/index-v2.html'), {
      query: { view: 'desktop-reminder' }
    })
  }

  reminderWindow.on('closed', () => {
    reminderWindow = null
  })

  return reminderWindow
}

export function showReminderWindow(data: unknown): void {
  currentReminderData = data
  const win = reminderWindow && !reminderWindow.isDestroyed() ? reminderWindow : createReminderWindow()

  // 如果浮窗已经处于显示状态（用户可能正在查看或展开了清单），不要在定时轮询中强行重设尺寸位置！
  if (!win.isVisible()) {
    positionReminderWindow(win, DEFAULT_WIDTH, DEFAULT_HEIGHT)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.showInactive()
  }

  win.webContents.send('reminder:data', data)
}

export function hideReminderWindow(): void {
  if (reminderWindow && !reminderWindow.isDestroyed()) {
    reminderWindow.hide()
    // 隐藏后，重置高度为默认尺寸，确保下一次弹出时是初始紧凑卡片
    positionReminderWindow(reminderWindow, DEFAULT_WIDTH, DEFAULT_HEIGHT)
  }
}

export function setupReminderIPC(
  showMainWindowFn: () => void,
  navigateOrderFn: (orderNo: string) => void
): void {
  // 预创建浮窗实例（隐藏状态，避免首次弹出时冷启动延迟）
  createReminderWindow()

  ipcMain.handle('reminder:show', (_e, data) => {
    showReminderWindow(data)
    return { ok: true }
  })

  ipcMain.handle('reminder:hide', () => {
    hideReminderWindow()
    return { ok: true }
  })

  ipcMain.handle('reminder:get-current', () => {
    return currentReminderData
  })

  ipcMain.handle('reminder:resize', (_e, dims: { width?: number; height?: number }) => {
    if (reminderWindow && !reminderWindow.isDestroyed()) {
      const targetW = dims?.width || DEFAULT_WIDTH
      const targetH = dims?.height || DEFAULT_HEIGHT
      positionReminderWindow(reminderWindow, targetW, targetH)
    }
    return { ok: true }
  })

  ipcMain.handle('reminder:open-order', (_e, orderNo: string) => {
    showMainWindowFn()
    navigateOrderFn(orderNo)
    return { ok: true }
  })
}
