#!/usr/bin/env node
const fs = require('fs')
const os = require('os')
const cp = require('child_process')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const TARGETS = [
  { file: '.env', key: 'MINIO_PUBLIC_HOST' },
  { file: '.env.example', key: 'MINIO_PUBLIC_HOST' }
]
const ANDROID_GRADLE = 'packages/android-app/app/build.gradle.kts'
const APP_PACKAGE = 'com.huanyu.collector'

function getLanIp() {
  const nets = os.networkInterfaces()
  const candidates = ['en0', 'wlan0', 'Wi-Fi']
  for (const name of candidates) {
    const list = nets[name] || []
    const hit = list.find((x) => x.family === 'IPv4' && !x.internal)
    if (hit) return hit.address
  }
  for (const entries of Object.values(nets)) {
    for (const x of entries || []) {
      if (x.family === 'IPv4' && !x.internal) return x.address
    }
  }
  throw new Error('未找到可用的本机 IPv4 地址')
}

function replaceEnvKey(fileRel, key, value) {
  const file = path.join(ROOT, fileRel)
  if (!fs.existsSync(file)) throw new Error(`文件不存在: ${fileRel}`)
  const text = fs.readFileSync(file, 'utf8')
  const re = new RegExp(`^${key}=.*$`, 'm')
  if (!re.test(text)) throw new Error(`未找到配置项 ${key}: ${fileRel}`)
  const next = text.replace(re, `${key}=${value}`)
  fs.writeFileSync(file, next, 'utf8')
}

function replaceAndroidBackendUrl(ip) {
  const file = path.join(ROOT, ANDROID_GRADLE)
  if (!fs.existsSync(file)) throw new Error(`文件不存在: ${ANDROID_GRADLE}`)
  const text = fs.readFileSync(file, 'utf8')
  const re = /buildConfigField\("String",\s*"BACKEND_URL",\s*"\\\"http:\/\/[^"]+:13000\\\""\)/
  if (!re.test(text)) throw new Error('未找到 Android BACKEND_URL 配置行')
  const next = text.replace(
    re,
    `buildConfigField("String", "BACKEND_URL", "\\"http://${ip}:13000\\"")`
  )
  fs.writeFileSync(file, next, 'utf8')
}

function syncDevicePrefs(ip) {
  try {
    const devices = cp
      .execSync('adb devices', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split('\n')
      .filter((l) => /\tdevice$/.test(l))
    if (devices.length === 0) return '未检测到已连接 Android 设备，跳过 App 本地配置同步'

    const prefPath = `/data/data/${APP_PACKAGE}/shared_prefs/huanyu_collector.xml`
    const cmd = [
      `adb shell "run-as ${APP_PACKAGE} sh -c '`,
      `if [ -f ${prefPath} ]; then `,
      `sed -i s#http://[0-9.]*:13000#http://${ip}:13000#g ${prefPath}; `,
      `fi'"`
    ].join('')
    cp.execSync(cmd, { stdio: 'ignore' })
    cp.execSync(`adb shell am force-stop ${APP_PACKAGE}`, { stdio: 'ignore' })
    return '已同步到已连接手机 App 本地配置（并重启进程）'
  } catch (e) {
    return `设备同步失败（可忽略，手工在 App 设置页改也行）: ${e.message}`
  }
}

function main() {
  const ipArg = process.argv[2]
  const ip = ipArg || getLanIp()
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`IP 格式不合法: ${ip}`)

  for (const t of TARGETS) replaceEnvKey(t.file, t.key, ip)
  replaceAndroidBackendUrl(ip)
  const syncMsg = syncDevicePrefs(ip)

  console.log(`已切换移动端网络配置到: ${ip}`)
  console.log(`- .env/.env.example: MINIO_PUBLIC_HOST=${ip}`)
  console.log(`- Android 默认 BACKEND_URL=http://${ip}:13000`)
  console.log(`- ${syncMsg}`)
  console.log('下一步：重启后端 `pnpm backend:dev`，并重新安装 Android `pnpm android:install`')
}

main()
