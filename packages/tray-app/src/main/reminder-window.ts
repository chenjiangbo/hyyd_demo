import { BrowserWindow, screen, ipcMain } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

const POPUP_WIDTH = 380
const POPUP_HEIGHT = 200
const MARGIN = 16

let reminderWindow: BrowserWindow | null = null
let currentReminderData: unknown = null

export function getReminderWindow(): BrowserWindow | null {
  return reminderWindow
}

export function positionReminderWindow(win: BrowserWindow): void {
  try {
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width, height, x, y } = primaryDisplay.workArea
    const posX = Math.round(x + width - POPUP_WIDTH - MARGIN)
    const posY = Math.round(y + height - POPUP_HEIGHT - MARGIN)
    win.setBounds({ x: posX, y: posY, width: POPUP_WIDTH, height: POPUP_HEIGHT })
  } catch (err) {
    console.error('[reminder-window] failed to position window:', err)
  }
}

export function createReminderWindow(): BrowserWindow {
  if (reminderWindow && !reminderWindow.isDestroyed()) {
    return reminderWindow
  }

  reminderWindow = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
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
      sandbox: false
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

  positionReminderWindow(win)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.showInactive()
  win.webContents.send('reminder:data', data)
}

export function hideReminderWindow(): void {
  if (reminderWindow && !reminderWindow.isDestroyed()) {
    reminderWindow.hide()
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

  ipcMain.handle('reminder:open-order', (_e, orderNo: string) => {
    hideReminderWindow()
    showMainWindowFn()
    navigateOrderFn(orderNo)
    return { ok: true }
  })
}
