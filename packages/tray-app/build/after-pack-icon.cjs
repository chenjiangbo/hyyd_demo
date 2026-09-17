const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

module.exports = async function writeWindowsIcon(context) {
  if (context.electronPlatformName !== 'win32') return

  const iconPath = resolve(__dirname, '../resources/icon.ico')
  const rceditPath = resolve(
    __dirname,
    '../../../node_modules/.pnpm/electron-winstaller@5.4.0/node_modules/electron-winstaller/vendor/rcedit.exe'
  )
  const executablePath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)

  if (!existsSync(iconPath) || !existsSync(executablePath)) return
  if (existsSync(rceditPath)) {
    execFileSync(rceditPath, [executablePath, '--set-icon', iconPath], { stdio: 'inherit' })
  } else {
    console.log('[after-pack-icon] rcedit not found, skipping manual icon patching')
  }
}
