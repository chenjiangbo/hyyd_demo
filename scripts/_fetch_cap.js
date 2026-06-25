const fs = require('fs')
const path = require('path')
const { Client } = require('ssh2')
const env = {}
for (const l of fs.readFileSync(path.join(__dirname, '../.env'), 'utf8').split(/\r?\n/)) {
  const t = l.trim()
  if (!t || t.startsWith('#')) continue
  const i = t.indexOf('=')
  if (i <= 0) continue
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')
}
const remote = process.argv[2]
const local = process.argv[3] || '/tmp/cap.png'
const c = new Client()
c.on('ready', () =>
  c.sftp((e, sftp) => {
    if (e) { console.error(e.message); process.exit(1) }
    sftp.fastGet(remote, local, (er) => {
      if (er) { console.error('get失败:', er.message); process.exit(1) }
      console.log('已下载到', local, fs.statSync(local).size, '字节')
      c.end()
    })
  })
).on('error', (e) => { console.error('SSH:', e.message); process.exit(1) }).connect({
  host: env.WIN_VM_HOST,
  port: parseInt(env.WIN_VM_PORT || '22', 10),
  username: env.WIN_VM_USERNAME,
  password: env.WIN_VM_PASSWORD
})
