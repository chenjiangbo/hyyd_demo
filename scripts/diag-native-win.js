// 诊断：better-sqlite3.node 与 electron.exe 各自的 PE 架构，判断是否 arch 不匹配。只读。
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
const exec = (command) =>
  new Promise((resolve) => {
    conn.exec(command, (err, stream) => {
      if (err) return resolve('ERR ' + err.message)
      let out = ''
      stream.on('data', (d) => (out += d)).stderr.on('data', (d) => (out += d))
      stream.on('close', () => resolve(out.trim()))
    })
  })

// 读 PE machine 字段：返回 x64 / arm64 / x86 / 其它
const peMachineExpr = (varPath) =>
  `$f=${varPath}; if(Test-Path $f){ $b=[System.IO.File]::ReadAllBytes($f); $off=[BitConverter]::ToInt32($b,60); $m=[BitConverter]::ToUInt16($b,$off+4); switch($m){0x8664{'x64'}0xAA64{'arm64'}0x14c{'x86'}default{('0x{0:X}' -f $m)}} } else {'MISSING'}`

conn
  .on('ready', async () => {
    const dir = env.WIN_VM_TARGET_DIR.replace(/\\/g, '/')
    const sqliteNode = await exec(
      pwsh(
        `Get-ChildItem -Path '${dir}/node_modules/.pnpm' -Recurse -Filter better_sqlite3.node -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName`
      )
    )
    const electronExe = await exec(
      pwsh(
        `Get-ChildItem -Path '${dir}/node_modules/.pnpm' -Recurse -Filter electron.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName`
      )
    )
    console.log('better_sqlite3.node:', sqliteNode || '(未找到)')
    console.log('  arch =', await exec(pwsh(peMachineExpr(`'${sqliteNode}'`))))
    console.log('electron.exe:', electronExe || '(未找到)')
    if (electronExe) console.log('  arch =', await exec(pwsh(peMachineExpr(`'${electronExe}'`))))
    // node 自身 arch（pnpm 用的）
    console.log('node arch =', await exec(`node -p "process.arch"`))
    conn.end()
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
