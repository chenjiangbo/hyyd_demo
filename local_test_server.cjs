const http = require('http')
const crypto = require('crypto')
const path = require('path')
const { PrismaClient } = require(path.join(__dirname, 'packages/backend/node_modules/@prisma/client'))

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL || 'postgresql://huanyu:huanyu_dev_pwd@127.0.0.1:5432/huanyu?schema=public'
    }
  }
})

const REMOTE_BACKEND = 'http://47.95.14.233:9093'
const PORT = 13000

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH')
  res.setHeader('Access-Control-Allow-Headers', '*')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = req.url || '/'
  console.log(`[LocalBackend] ${req.method} ${url}`)

  // 1. 本地处理 POST /api/v1/login
  if (url === '/api/v1/login' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const { username, employeeCode, account, password } = JSON.parse(body || '{}')
        const user = (username || employeeCode || account || '').trim()
        const pwd = (password || '').trim()

        if (!user || !pwd) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '用户名和密码不能为空' }))
          return
        }

        // 仅通过 token（工号）查找
        const emp = await prisma.employee.findUnique({
          where: { token: user }
        })

        if (!emp) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '用户名或密码错误' }))
          return
        }

        // 校验启用状态 ENABLED
        if (emp.enabled === 0) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '账号已被停用，请联系管理员' }))
          return
        }

        // 计算用户输入的 MD5 密文
        const inputMd5 = /^[a-f0-9]{32}$/i.test(pwd)
          ? pwd.toLowerCase()
          : crypto.createHash('md5').update(pwd).digest('hex').toLowerCase()

        const storedPwd = (emp.password || '').trim()
        if (!storedPwd) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '用户名或密码错误' }))
          return
        }

        const storedMd5 = /^[a-f0-9]{32}$/i.test(storedPwd)
          ? storedPwd.toLowerCase()
          : crypto.createHash('md5').update(storedPwd).digest('hex').toLowerCase()

        if (inputMd5 !== storedMd5) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '用户名或密码错误' }))
          return
        }

        // 登录成功
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          data: {
            id: emp.id,
            employeeCode: emp.token,
            displayName: emp.name,
            token: emp.token
          }
        }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `服务器内部错误: ${err.message}` }))
      }
    })
    return
  }

  // 2. 本地处理 POST /api/v1/me/password 或 /api/v1/change-password 修改密码接口
  if ((url === '/api/v1/me/password' || url === '/api/v1/change-password') && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body || '{}')
        const empCode = req.headers['x-employee-code'] || parsed.employeeCode || parsed.username || parsed.account
        if (!empCode) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '未登录或缺少工号信息' }))
          return
        }

        const { oldPassword, newPassword } = parsed
        const oldPwd = (oldPassword || '').trim()
        const newPwd = (newPassword || '').trim()

        if (!oldPwd || !newPwd) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '旧密码和新密码不能为空' }))
          return
        }

        const emp = await prisma.employee.findUnique({
          where: { token: String(empCode).trim() }
        })

        if (!emp) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '未找到当前登录用户' }))
          return
        }

        const inputOldMd5 = /^[a-f0-9]{32}$/i.test(oldPwd)
          ? oldPwd.toLowerCase()
          : crypto.createHash('md5').update(oldPwd).digest('hex').toLowerCase()

        const storedPwd = (emp.password || '').trim()
        if (!storedPwd) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '原账号未设置密码，请联系管理员' }))
          return
        }

        const storedOldMd5 = /^[a-f0-9]{32}$/i.test(storedPwd)
          ? storedPwd.toLowerCase()
          : crypto.createHash('md5').update(storedPwd).digest('hex').toLowerCase()

        if (inputOldMd5 !== storedOldMd5) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '旧密码输入不正确' }))
          return
        }

        const newMd5 = /^[a-f0-9]{32}$/i.test(newPwd)
          ? newPwd.toLowerCase()
          : crypto.createHash('md5').update(newPwd).digest('hex').toLowerCase()

        if (newMd5 === storedOldMd5) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '新密码不能与旧密码相同' }))
          return
        }

        await prisma.employee.update({
          where: { id: emp.id },
          data: { password: newMd5 }
        })

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: '密码修改成功' }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `服务器内部错误: ${err.message}` }))
      }
    })
    return
  }

  // 3. 健康检查接口
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'OK', localDb: 'PostgreSQL-16', port: 15432, timestamp: new Date().toISOString() }))
    return
  }

  // 4. 其他业务接口代理转发至远程服务器
  const targetUrl = `${REMOTE_BACKEND}${url}`
  const proxyReq = http.request(targetUrl, {
    method: req.method,
    headers: { ...req.headers, host: '47.95.14.233:9093' }
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers)
    proxyRes.pipe(res)
  })

  proxyReq.on('error', err => {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `代理转发失败: ${err.message}` }))
  })

  req.pipe(proxyReq)
})

server.listen(PORT, () => {
  console.log(`✅ 本地后端服务已启动并连接本地 PostgreSQL 数据库: http://localhost:${PORT}`)
})
