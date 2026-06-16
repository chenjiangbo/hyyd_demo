// 在 Windows 机器上：找一张已采集的截图，跑 sidecar --test-image，打印 OCR + 结构化消息。
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
const user = env.WIN_VM_USERNAME
const dir = env.WIN_VM_TARGET_DIR.replace(/\\/g, '/')
const exe = `${dir}/packages/tray-app/resources/capture-sidecar/hyyd-capture-sidecar.exe`
const framesDir = `C:/Users/${user}/AppData/Local/HyydCaptureSidecar/frames`
// 允许命令行传指定图片路径：node scripts/ssh-test-image.js "C:\\path\\to.png"
const explicit = process.argv[2]

const ps = explicit
  ? `& '${exe}' --test-image '${explicit}'`
  : `$f = Get-ChildItem '${framesDir}' -Recurse -Filter *.png -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName; ` +
    `if (-not $f) { 'NO_PNG: 没有已采集的截图，先用 --standalone 截一张客户会话，或传图片路径' } else { Write-Output ('IMG=' + $f); & '${exe}' --test-image $f }`

const conn = new Client()
conn
  .on('ready', () => {
    conn.exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, (err, stream) => {
      if (err) {
        console.error(err.message)
        process.exit(1)
      }
      stream.on('data', (d) => process.stdout.write(d)).stderr.on('data', (d) => process.stdout.write(d))
      stream.on('close', () => conn.end())
    })
  })
  .on('error', (e) => {
    console.error('SSH 失败:', e.message)
    process.exit(1)
  })
  .connect({
    host: env.WIN_VM_HOST,
    port: parseInt(env.WIN_VM_PORT || '22', 10),
    username: user,
    password: env.WIN_VM_PASSWORD
  })
