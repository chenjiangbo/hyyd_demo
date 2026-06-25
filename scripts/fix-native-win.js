// 在 ARM64 Windows VM 上把 better-sqlite3 重建为 arm64（匹配 arm64 Electron）。
// 复用 deploy-win 的 env + ssh helper，流式输出。
const fs = require('fs')
const path = require('path')
const { Client } = require('ssh2')

function loadEnv() {
  const env = {}
  for (const line of fs.readFileSync(path.join(__dirname, '../.env'), 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')
  }
  return env
}
const env = loadEnv()
const conn = new Client()
const pwsh = (c) => `powershell -NoProfile -Command "${c.replace(/"/g, '\\"')}"`
function exec(command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err)
      let code = 0
      stream
        .on('data', (d) => process.stdout.write(d))
        .stderr.on('data', (d) => process.stderr.write(d))
      stream.on('close', (c) => resolve(c ?? code))
    })
  })
}

conn
  .on('ready', async () => {
    const dir = env.WIN_VM_TARGET_DIR.replace(/\\/g, '/')
    console.log('📡 已连接，开始把 better-sqlite3 重建为 arm64…\n')
    // 强制 arm64 重建（install-app-deps 会按 --arch 下载/编译，匹配 arm64 Electron）
    await exec(
      pwsh(
        `cd '${dir}/packages/tray-app'; $env:npm_config_arch='arm64'; $env:npm_config_target_arch='arm64'; pnpm exec electron-builder install-app-deps --arch arm64`
      )
    )
    conn.end()
    console.log('\n✅ 重建命令执行完毕。再跑 diag 确认 arch 是否变 arm64。')
  })
  .on('error', (e) => {
    console.error('SSH 失败:', e.message)
    process.exit(1)
  })
  .connect({
    host: env.WIN_VM_HOST,
    port: parseInt(env.WIN_VM_PORT || '22', 10),
    username: env.WIN_VM_USERNAME,
    password: env.WIN_VM_PASSWORD
  })
