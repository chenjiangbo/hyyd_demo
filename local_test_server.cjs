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

// 自动建表与注释初始化
async function autoInitDatabase() {
  const initSql = `
    CREATE TABLE IF NOT EXISTS f_hy_kswh (
      id VARCHAR(50) PRIMARY KEY, name VARCHAR(100), ms VARCHAR(200),
      state VARCHAR(50) DEFAULT '启用', c_date VARCHAR(50), u_date VARCHAR(50)
    );
    COMMENT ON TABLE f_hy_kswh IS '对内科室大类主表（一级科室）';
    COMMENT ON COLUMN f_hy_kswh.id IS '科室大类编码 (主键，如 0001)';
    COMMENT ON COLUMN f_hy_kswh.name IS '科室大类名称 (如 外科系统)';
    COMMENT ON COLUMN f_hy_kswh.ms IS '描述说明';
    COMMENT ON COLUMN f_hy_kswh.state IS '状态 (启用 / 停用)';
    COMMENT ON COLUMN f_hy_kswh.c_date IS '创建时间';
    COMMENT ON COLUMN f_hy_kswh.u_date IS '更新时间';

    CREATE TABLE IF NOT EXISTS f_hy_xfks (
      id VARCHAR(50) PRIMARY KEY, name VARCHAR(100), state VARCHAR(50) DEFAULT '启用',
      u_date VARCHAR(50), name_yjks VARCHAR(50), xh VARCHAR(50)
    );
    COMMENT ON TABLE f_hy_xfks IS '对内细分科室子表（二级科室）';
    COMMENT ON COLUMN f_hy_xfks.id IS '细分科室编码 (主键，如 00010002)';
    COMMENT ON COLUMN f_hy_xfks.xh IS '序号 (如 0002)';
    COMMENT ON COLUMN f_hy_xfks.name_yjks IS '所属一级科室编码 (外键)';
    COMMENT ON COLUMN f_hy_xfks.name IS '科室细分名称 (如 胸外科)';
    COMMENT ON COLUMN f_hy_xfks.state IS '状态 (启用 / 停用)';
    COMMENT ON COLUMN f_hy_xfks.u_date IS '更新时间';

    CREATE TABLE IF NOT EXISTS f_hy_yywh (
      id VARCHAR(50) PRIMARY KEY, name VARCHAR(200), level VARCHAR(100), bq VARCHAR(200),
      dq VARCHAR(100), dz VARCHAR(200), tips VARCHAR(500), bz VARCHAR(500),
      state VARCHAR(50) DEFAULT '启用', dz1 VARCHAR(200), dz2 VARCHAR(200),
      dq_sf VARCHAR(50), dq_cs VARCHAR(50), dz3 VARCHAR(200), u_date VARCHAR(50)
    );
    COMMENT ON TABLE f_hy_yywh IS '医院维护主表';
    COMMENT ON COLUMN f_hy_yywh.id IS '医院编码 (主键，如 0001)';
    COMMENT ON COLUMN f_hy_yywh.name IS '医院名称 (如 北京协和医院)';
    COMMENT ON COLUMN f_hy_yywh.level IS '医院级别 (如 三级甲等)';
    COMMENT ON COLUMN f_hy_yywh.bq IS '标签';
    COMMENT ON COLUMN f_hy_yywh.dq IS '地区';
    COMMENT ON COLUMN f_hy_yywh.dz IS '总地址';
    COMMENT ON COLUMN f_hy_yywh.tips IS '就诊提示 Tips';
    COMMENT ON COLUMN f_hy_yywh.bz IS '备注';
    COMMENT ON COLUMN f_hy_yywh.state IS '状态 (启用 / 停用)';
    COMMENT ON COLUMN f_hy_yywh.dz1 IS '医院地址1';
    COMMENT ON COLUMN f_hy_yywh.dz2 IS '医院地址2';
    COMMENT ON COLUMN f_hy_yywh.dz3 IS '医院地址3';
    COMMENT ON COLUMN f_hy_yywh.dq_sf IS '省份编码';
    COMMENT ON COLUMN f_hy_yywh.dq_cs IS '城市编码';
    COMMENT ON COLUMN f_hy_yywh.u_date IS '更新时间';

    CREATE TABLE IF NOT EXISTS f_hy_yy_ks (
      id VARCHAR(50) PRIMARY KEY, name VARCHAR(200), ksdl VARCHAR(100), ksxf VARCHAR(100),
      state VARCHAR(50) DEFAULT '启用', u_date VARCHAR(50), id_yy VARCHAR(50), xh VARCHAR(50)
    );
    COMMENT ON TABLE f_hy_yy_ks IS '医院科室子表（对外科室）';
    COMMENT ON COLUMN f_hy_yy_ks.id IS '医院科室编码 (主键，如 00010001)';
    COMMENT ON COLUMN f_hy_yy_ks.xh IS '序号 (如 0001)';
    COMMENT ON COLUMN f_hy_yy_ks.id_yy IS '所属医院编码 (外键)';
    COMMENT ON COLUMN f_hy_yy_ks.name IS '科室细分名称 (如 普通内科)';
    COMMENT ON COLUMN f_hy_yy_ks.ksdl IS '对应对内一级科室大类 (如 0002)';
    COMMENT ON COLUMN f_hy_yy_ks.ksxf IS '对应对内二级科室细分 (如 00020001)';
    COMMENT ON COLUMN f_hy_yy_ks.state IS '状态 (启用 / 停用)';
    COMMENT ON COLUMN f_hy_yy_ks.u_date IS '更新时间';

    CREATE TABLE IF NOT EXISTS f_hy_ys (
      id VARCHAR(50) PRIMARY KEY, name VARCHAR(100), sex VARCHAR(50), tel VARCHAR(200),
      em VARCHAR(100), dq_sf VARCHAR(50), dq_cs VARCHAR(50), yy VARCHAR(100),
      dwks VARCHAR(100), zc VARCHAR(50), jxzc VARCHAR(50), yyxzzw VARCHAR(100),
      shrz VARCHAR(100), sc VARCHAR(500), bz VARCHAR(500), state VARCHAR(50) DEFAULT '启用',
      csrq VARCHAR(50), c_date VARCHAR(50), u_date VARCHAR(50)
    );
    COMMENT ON TABLE f_hy_ys IS '医生档案表';
    COMMENT ON COLUMN f_hy_ys.id IS '医生编码 (主键，5位编码，如 00001)';
    COMMENT ON COLUMN f_hy_ys.name IS '医生姓名';
    COMMENT ON COLUMN f_hy_ys.sex IS '性别 (男 / 女)';
    COMMENT ON COLUMN f_hy_ys.tel IS '手机号码';
    COMMENT ON COLUMN f_hy_ys.em IS '电子邮箱';
    COMMENT ON COLUMN f_hy_ys.dq_sf IS '省份';
    COMMENT ON COLUMN f_hy_ys.dq_cs IS '城市';
    COMMENT ON COLUMN f_hy_ys.yy IS '所属医院编码';
    COMMENT ON COLUMN f_hy_ys.dwks IS '所属科室编码';
    COMMENT ON COLUMN f_hy_ys.zc IS '临床职称';
    COMMENT ON COLUMN f_hy_ys.jxzc IS '教学职称';
    COMMENT ON COLUMN f_hy_ys.yyxzzw IS '医院行政职务';
    COMMENT ON COLUMN f_hy_ys.shrz IS '社会任职';
    COMMENT ON COLUMN f_hy_ys.sc IS '擅长主治领域';
    COMMENT ON COLUMN f_hy_ys.bz IS '备注';
    COMMENT ON COLUMN f_hy_ys.state IS '状态 (启用 / 停用)';
    COMMENT ON COLUMN f_hy_ys.csrq IS '出生日期';
    COMMENT ON COLUMN f_hy_ys.c_date IS '创建时间';
    COMMENT ON COLUMN f_hy_ys.u_date IS '更新时间';

    CREATE TABLE IF NOT EXISTS f_hy_qd (
      id VARCHAR(50) PRIMARY KEY, name VARCHAR(100), state VARCHAR(50) DEFAULT '启用',
      c_date VARCHAR(50), u_date VARCHAR(50)
    );
    COMMENT ON TABLE f_hy_qd IS '就诊渠道主表';
    COMMENT ON COLUMN f_hy_qd.id IS '渠道编码 (主键，如 0001)';
    COMMENT ON COLUMN f_hy_qd.name IS '渠道名称 (如 泰康在线)';
    COMMENT ON COLUMN f_hy_qd.state IS '状态 (启用 / 停用)';
    COMMENT ON COLUMN f_hy_qd.c_date IS '创建时间';
    COMMENT ON COLUMN f_hy_qd.u_date IS '更新时间';

    CREATE TABLE IF NOT EXISTS f_hy_cp_qd (
      id VARCHAR(100) PRIMARY KEY, xh VARCHAR(50), name VARCHAR(100), cpjg NUMERIC(18, 2),
      nbyjcp VARCHAR(100), nbejcp VARCHAR(100), state VARCHAR(50) DEFAULT '启用',
      id_yj VARCHAR(50), u_date VARCHAR(50)
    );
    COMMENT ON TABLE f_hy_cp_qd IS '渠道产品价格表';
    COMMENT ON COLUMN f_hy_cp_qd.id IS '渠道产品编码 (主键，如 0001001)';
    COMMENT ON COLUMN f_hy_cp_qd.xh IS '序号 (如 001)';
    COMMENT ON COLUMN f_hy_cp_qd.id_yj IS '所属渠道编码 (外键)';
    COMMENT ON COLUMN f_hy_cp_qd.name IS '渠道产品名称 (如 半日陪诊)';
    COMMENT ON COLUMN f_hy_cp_qd.cpjg IS '渠道结算价格';
    COMMENT ON COLUMN f_hy_cp_qd.nbyjcp IS '对应对内一级产品';
    COMMENT ON COLUMN f_hy_cp_qd.nbejcp IS '对应对内二级产品';
    COMMENT ON COLUMN f_hy_cp_qd.state IS '状态 (启用 / 停用)';
    COMMENT ON COLUMN f_hy_cp_qd.u_date IS '更新时间';

    CREATE TABLE IF NOT EXISTS f_hy_cp (
      id VARCHAR(50) PRIMARY KEY, name VARCHAR(100), ms VARCHAR(200), lx VARCHAR(50),
      state VARCHAR(50) DEFAULT '启用', c_date VARCHAR(50), u_date VARCHAR(50)
    );
    COMMENT ON TABLE f_hy_cp IS '对内产品大类主表';
    COMMENT ON COLUMN f_hy_cp.id IS '产品大类编码 (主键，如 0001)';
    COMMENT ON COLUMN f_hy_cp.name IS '产品大类名称 (如 院内接续)';
    COMMENT ON COLUMN f_hy_cp.ms IS '产品体系描述';
    COMMENT ON COLUMN f_hy_cp.lx IS '产品类型 (门诊/住院/体检/咨询/其他)';
    COMMENT ON COLUMN f_hy_cp.state IS '状态 (启用 / 停用)';
    COMMENT ON COLUMN f_hy_cp.c_date IS '创建时间';
    COMMENT ON COLUMN f_hy_cp.u_date IS '更新时间';

    CREATE TABLE IF NOT EXISTS f_hy_zcp (
      id VARCHAR(100) PRIMARY KEY, xh VARCHAR(50), name VARCHAR(100),
      state VARCHAR(50) DEFAULT '启用', u_date VARCHAR(50), id_yj VARCHAR(50)
    );
    COMMENT ON TABLE f_hy_zcp IS '对内子产品表';
    COMMENT ON COLUMN f_hy_zcp.id IS '子产品编码 (主键，如 00010001)';
    COMMENT ON COLUMN f_hy_zcp.xh IS '序号 (如 0001)';
    COMMENT ON COLUMN f_hy_zcp.id_yj IS '所属大类产品编码 (外键)';
    COMMENT ON COLUMN f_hy_zcp.name IS '子产品名称';
    COMMENT ON COLUMN f_hy_zcp.state IS '状态 (启用 / 停用)';
    COMMENT ON COLUMN f_hy_zcp.u_date IS '更新时间';

    CREATE TABLE IF NOT EXISTS zfqd (
      id VARCHAR(50) PRIMARY KEY, name VARCHAR(100), yy VARCHAR(50),
      start VARCHAR(50) DEFAULT '启用', u_date VARCHAR(50), zf_id VARCHAR(50),
      by1 VARCHAR(50), by2 VARCHAR(50)
    );
    COMMENT ON TABLE zfqd IS '支付渠道表';
    COMMENT ON COLUMN zfqd.id IS '支付渠道编码 (主键，如 0001)';
    COMMENT ON COLUMN zfqd.name IS '支付渠道名称 (如 北京协和1)';
    COMMENT ON COLUMN zfqd.yy IS '所属医院编码';
    COMMENT ON COLUMN zfqd.zf_id IS '支付商户号/平台账号ID';
    COMMENT ON COLUMN zfqd.by1 IS '省份编码';
    COMMENT ON COLUMN zfqd.by2 IS '城市编码';
    COMMENT ON COLUMN zfqd.start IS '状态 (启用 / 停用)';
    COMMENT ON COLUMN zfqd.u_date IS '更新时间';

    CREATE TABLE IF NOT EXISTS f_hy_pzr (
      id VARCHAR(50) PRIMARY KEY, name VARCHAR(100), xb VARCHAR(50), sj VARCHAR(100),
      sf VARCHAR(50), cs VARCHAR(50), bz VARCHAR(500), state VARCHAR(50) DEFAULT '启用',
      c_date VARCHAR(50), u_date VARCHAR(50), pzrlx VARCHAR(50)
    );
    COMMENT ON TABLE f_hy_pzr IS '陪诊人员档案表';
    COMMENT ON COLUMN f_hy_pzr.id IS '陪诊人工号/编码 (主键，5位编码，如 00001)';
    COMMENT ON COLUMN f_hy_pzr.name IS '陪诊人姓名';
    COMMENT ON COLUMN f_hy_pzr.xb IS '性别 (男 / 女)';
    COMMENT ON COLUMN f_hy_pzr.sj IS '手机号码';
    COMMENT ON COLUMN f_hy_pzr.sf IS '省份编码';
    COMMENT ON COLUMN f_hy_pzr.cs IS '城市编码';
    COMMENT ON COLUMN f_hy_pzr.pzrlx IS '陪诊人员类型 (外包 / 本部)';
    COMMENT ON COLUMN f_hy_pzr.bz IS '备注信息';
    COMMENT ON COLUMN f_hy_pzr.state IS '状态 (启用 / 停用)';
    COMMENT ON COLUMN f_hy_pzr.c_date IS '创建时间';
    COMMENT ON COLUMN f_hy_pzr.u_date IS '更新时间';

    CREATE TABLE IF NOT EXISTS dim_cslb (
      s_id VARCHAR(20), s_name VARCHAR(50),
      x_id VARCHAR(20) PRIMARY KEY, x_name VARCHAR(50)
    );
    COMMENT ON TABLE dim_cslb IS '城市列表维度表';
    COMMENT ON COLUMN dim_cslb.s_id IS '省份编码';
    COMMENT ON COLUMN dim_cslb.s_name IS '省份名称';
    COMMENT ON COLUMN dim_cslb.x_id IS '城市/区县编码 (主键)';
    COMMENT ON COLUMN dim_cslb.x_name IS '城市/区县名称';

    CREATE TABLE IF NOT EXISTS dim_yydjb486 (
      id VARCHAR(100) PRIMARY KEY, name VARCHAR(100)
    );
    COMMENT ON TABLE dim_yydjb486 IS '医院等级类别表';
  `

  const statements = initSql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'))

  for (const sql of statements) {
    try {
      await prisma.$executeRawUnsafe(sql)
    } catch (err) {
      // ignore table already exists or comment notices
    }
  }
  console.log('✅ PostgreSQL 11 张字典表与中文注释初始化检测完成！')
}

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

        const emp = await prisma.employee.findUnique({
          where: { token: user }
        })

        if (!emp) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '用户名或密码错误' }))
          return
        }

        if (emp.enabled === 0) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '账号已被停用，请联系管理员' }))
          return
        }

        const inputMd5 = /^[a-f0-9]{32}$/i.test(pwd)
          ? pwd.toLowerCase()
          : crypto.createHash('md5').update(pwd).digest('hex').toLowerCase()

        const storedPwd = (emp.password || '').trim()
        const storedMd5 = /^[a-f0-9]{32}$/i.test(storedPwd)
          ? storedPwd.toLowerCase()
          : crypto.createHash('md5').update(storedPwd).digest('hex').toLowerCase()

        if (inputMd5 !== storedMd5) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '用户名或密码错误' }))
          return
        }

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

  // 2. 本地处理密码修改
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
        const emp = await prisma.employee.findUnique({ where: { token: String(empCode).trim() } })
        if (!emp) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '未找到当前登录用户' }))
          return
        }
        const inputOldMd5 = /^[a-f0-9]{32}$/i.test(oldPwd) ? oldPwd.toLowerCase() : crypto.createHash('md5').update(oldPwd).digest('hex').toLowerCase()
        const storedPwd = (emp.password || '').trim()
        const storedOldMd5 = /^[a-f0-9]{32}$/i.test(storedPwd) ? storedPwd.toLowerCase() : crypto.createHash('md5').update(storedPwd).digest('hex').toLowerCase()
        if (inputOldMd5 !== storedOldMd5) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: '旧密码输入不正确' }))
          return
        }
        const newMd5 = /^[a-f0-9]{32}$/i.test(newPwd) ? newPwd.toLowerCase() : crypto.createHash('md5').update(newPwd).digest('hex').toLowerCase()
        await prisma.employee.update({ where: { id: emp.id }, data: { password: newMd5 } })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: '密码修改成功' }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `服务器内部错误: ${err.message}` }))
      }
    })
    return
  }

  // 3. 对内科室字典 (f_hy_kswh + f_hy_xfks)
  if ((url === '/api/v1/departments' || url === '/api/v1/departments/') && req.method === 'GET') {
    try {
      const yjList = await prisma.$queryRawUnsafe(`
        SELECT id, name, ms, state, c_date, u_date
        FROM f_hy_kswh
        ORDER BY id ASC;
      `)
      const ejList = await prisma.$queryRawUnsafe(`
        SELECT id, xh, name_yjks, name, state, u_date
        FROM f_hy_xfks
        ORDER BY name_yjks ASC, xh ASC;
      `)
      const ejMap = new Map()
      for (const ej of ejList) {
        if (!ejMap.has(ej.name_yjks)) ejMap.set(ej.name_yjks, [])
        ejMap.get(ej.name_yjks).push(ej)
      }
      const result = yjList.map(yj => ({
        ...yj,
        subDepartments: ejMap.get(yj.id) || []
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: result }))
    } catch (err) {
      console.error('Fetch departments error:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: `获取科室列表失败: ${err.message}` }))
    }
    return
  }

  if ((url === '/api/v1/departments/save' || url === '/api/v1/departments/batch' || url === '/api/v1/departments') && (req.method === 'POST' || req.method === 'PUT')) {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}')
        const deptList = Array.isArray(payload) ? payload : (payload.data || payload.departments || [])
        await prisma.$transaction(async (tx) => {
          const currentYj = await tx.$queryRawUnsafe(`SELECT id FROM f_hy_kswh`)
          const currentYjIds = new Set(currentYj.map(r => r.id))
          const newYjIds = new Set(deptList.map(d => String(d.id).trim()))
          for (const oldId of currentYjIds) {
            if (!newYjIds.has(oldId)) {
              await tx.$executeRawUnsafe(`DELETE FROM f_hy_xfks WHERE name_yjks = $1`, oldId)
              await tx.$executeRawUnsafe(`DELETE FROM f_hy_kswh WHERE id = $1`, oldId)
            }
          }
          for (const d of deptList) {
            const dId = String(d.id).trim()
            await tx.$executeRawUnsafe(`
              INSERT INTO f_hy_kswh (id, name, ms, state, c_date, u_date)
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name, ms = EXCLUDED.ms, state = EXCLUDED.state,
                c_date = EXCLUDED.c_date, u_date = EXCLUDED.u_date;
            `, dId, d.name || '', d.ms || '', d.state || '启用', d.c_date || '', d.u_date || '')

            const subList = d.subDepartments || []
            const currentEj = await tx.$queryRawUnsafe(`SELECT id FROM f_hy_xfks WHERE name_yjks = $1`, dId)
            const currentEjIds = new Set(currentEj.map(r => r.id))
            const newEjIds = new Set(subList.map(s => String(s.id).trim()))
            for (const oldSubId of currentEjIds) {
              if (!newEjIds.has(oldSubId)) {
                await tx.$executeRawUnsafe(`DELETE FROM f_hy_xfks WHERE id = $1`, oldSubId)
              }
            }
            for (const sub of subList) {
              const subId = String(sub.id).trim()
              const xh = String(sub.xh || subId.slice(-4)).trim()
              await tx.$executeRawUnsafe(`
                INSERT INTO f_hy_xfks (id, name, state, u_date, name_yjks, xh)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (id) DO UPDATE SET
                  xh = EXCLUDED.xh, name_yjks = EXCLUDED.name_yjks, name = EXCLUDED.name,
                  state = EXCLUDED.state, u_date = EXCLUDED.u_date;
              `, subId, sub.name || '', sub.state || '启用', sub.u_date || '', dId, xh)
            }
          }
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: '科室数据已成功保存至 PostgreSQL 数据库' }))
      } catch (err) {
        console.error('Save departments error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: `保存科室失败: ${err.message}` }))
      }
    })
    return
  }

  // 4. 医院管理字典 (f_hy_yywh + f_hy_yy_ks)
  if ((url === '/api/v1/hospitals' || url === '/api/v1/hospitals/') && req.method === 'GET') {
    try {
      const hList = await prisma.$queryRawUnsafe(`
        SELECT id, name, level, bq, dq, dz, tips, bz, state, dz1, dz2, dq_sf, dq_cs, dz3, u_date
        FROM f_hy_yywh
        ORDER BY id ASC;
      `)
      const dwList = await prisma.$queryRawUnsafe(`
        SELECT id, xh, id_yy, name, ksdl, ksxf, state, u_date
        FROM f_hy_yy_ks
        ORDER BY id_yy ASC, xh ASC;
      `)
      const dwMap = new Map()
      for (const dw of dwList) {
        if (!dwMap.has(dw.id_yy)) dwMap.set(dw.id_yy, [])
        dwMap.get(dw.id_yy).push(dw)
      }
      const result = hList.map(h => ({
        ...h,
        externalDepartments: dwMap.get(h.id) || []
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: result }))
    } catch (err) {
      console.error('Fetch hospitals error:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: `获取医院列表失败: ${err.message}` }))
    }
    return
  }

  if ((url === '/api/v1/hospitals/save' || url === '/api/v1/hospitals/batch' || url === '/api/v1/hospitals') && (req.method === 'POST' || req.method === 'PUT')) {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}')
        const hList = Array.isArray(payload) ? payload : (payload.data || payload.hospitals || [])
        await prisma.$transaction(async (tx) => {
          const currentH = await tx.$queryRawUnsafe(`SELECT id FROM f_hy_yywh`)
          const currentHIds = new Set(currentH.map(r => r.id))
          const newHIds = new Set(hList.map(h => String(h.id).trim()))
          for (const oldId of currentHIds) {
            if (!newHIds.has(oldId)) {
              await tx.$executeRawUnsafe(`DELETE FROM f_hy_yy_ks WHERE id_yy = $1`, oldId)
              await tx.$executeRawUnsafe(`DELETE FROM f_hy_yywh WHERE id = $1`, oldId)
            }
          }
          for (const h of hList) {
            const hId = String(h.id).trim()
            await tx.$executeRawUnsafe(`
              INSERT INTO f_hy_yywh (id, name, level, bq, dq, dz, tips, bz, state, dz1, dz2, dq_sf, dq_cs, dz3, u_date)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
              ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name, level = EXCLUDED.level, bq = EXCLUDED.bq, dq = EXCLUDED.dq, dz = EXCLUDED.dz,
                tips = EXCLUDED.tips, bz = EXCLUDED.bz, state = EXCLUDED.state,
                dz1 = EXCLUDED.dz1, dz2 = EXCLUDED.dz2, dq_sf = EXCLUDED.dq_sf, dq_cs = EXCLUDED.dq_cs,
                dz3 = EXCLUDED.dz3, u_date = EXCLUDED.u_date;
            `, hId, h.name || '', h.level || '', h.bq || '', h.dq || '', h.dz || '', h.tips || '', h.bz || '', h.state || '启用', h.dz1 || '', h.dz2 || '', h.dq_sf || '', h.dq_cs || '', h.dz3 || '', h.u_date || '')

            const extList = h.externalDepartments || []
            const currentDw = await tx.$queryRawUnsafe(`SELECT id FROM f_hy_yy_ks WHERE id_yy = $1`, hId)
            const currentDwIds = new Set(currentDw.map(r => r.id))
            const newDwIds = new Set(extList.map(d => String(d.id).trim()))
            for (const oldSub of currentDwIds) {
              if (!newDwIds.has(oldSub)) {
                await tx.$executeRawUnsafe(`DELETE FROM f_hy_yy_ks WHERE id = $1`, oldSub)
              }
            }
            for (const d of extList) {
              const dId = String(d.id).trim()
              const xh = String(d.xh || dId.slice(-4)).trim()
              await tx.$executeRawUnsafe(`
                INSERT INTO f_hy_yy_ks (id, name, ksdl, ksxf, state, u_date, id_yy, xh)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                ON CONFLICT (id) DO UPDATE SET
                  xh = EXCLUDED.xh, id_yy = EXCLUDED.id_yy, name = EXCLUDED.name,
                  ksdl = EXCLUDED.ksdl, ksxf = EXCLUDED.ksxf,
                  state = EXCLUDED.state, u_date = EXCLUDED.u_date;
              `, dId, d.name || '', d.ksdl || '', d.ksxf || '', d.state || '启用', d.u_date || '', hId, xh)
            }
          }
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: '医院数据已成功保存至 PostgreSQL 数据库' }))
      } catch (err) {
        console.error('Save hospitals error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: `保存医院失败: ${err.message}` }))
      }
    })
    return
  }

  // 5. 医生管理字典 (f_hy_ys)
  if ((url === '/api/v1/doctors' || url === '/api/v1/doctors/') && req.method === 'GET') {
    try {
      const ysList = await prisma.$queryRawUnsafe(`
        SELECT id, name, sex, tel, em, dq_sf, dq_cs, yy, dwks, zc, jxzc, yyxzzw, shrz, sc, bz, state, csrq, c_date, u_date
        FROM f_hy_ys
        ORDER BY id ASC;
      `)
      const result = ysList.map(y => ({
        id: y.id,
        name: y.name || '',
        gender: y.sex || '男',
        sex: y.sex || '男',
        phone: y.tel || '',
        tel: y.tel || '',
        email: y.em || '',
        em: y.em || '',
        province: y.dq_sf || '',
        dq_sf: y.dq_sf || '',
        city: y.dq_cs || '',
        dq_cs: y.dq_cs || '',
        hospital: y.yy || '',
        yy: y.yy || '',
        department: y.dwks || '',
        dwks: y.dwks || '',
        title: y.zc || '',
        zc: y.zc || '',
        teachingTitle: y.jxzc || '',
        jxzc: y.jxzc || '',
        adminPosition: y.yyxzzw || '',
        yyxzzw: y.yyxzzw || '',
        socialPosition: y.shrz || '',
        shrz: y.shrz || '',
        specialty: y.sc || '',
        sc: y.sc || '',
        remark: y.bz || '',
        bz: y.bz || '',
        status: y.state === '停用' ? 'disabled' : 'enabled',
        state: y.state || '启用',
        birthday: y.csrq || '',
        csrq: y.csrq || '',
        createdAt: y.c_date || '',
        c_date: y.c_date || '',
        updatedAt: y.u_date || '',
        u_date: y.u_date || ''
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: result }))
    } catch (err) {
      console.error('Fetch doctors error:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: `获取医生列表失败: ${err.message}` }))
    }
    return
  }

  if ((url === '/api/v1/doctors/save' || url === '/api/v1/doctors/batch' || url === '/api/v1/doctors') && (req.method === 'POST' || req.method === 'PUT')) {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}')
        const doctorList = Array.isArray(payload) ? payload : (payload.data || payload.doctors || [])
        await prisma.$transaction(async (tx) => {
          const current = await tx.$queryRawUnsafe(`SELECT id FROM f_hy_ys`)
          const currentIds = new Set(current.map(r => r.id))
          const newIds = new Set(doctorList.map(d => String(d.id).trim()))
          for (const oldId of currentIds) {
            if (!newIds.has(oldId)) {
              await tx.$executeRawUnsafe(`DELETE FROM f_hy_ys WHERE id = $1`, oldId)
            }
          }
          for (const doc of doctorList) {
            const docId = String(doc.id).trim()
            const sex = doc.sex || doc.gender || '男'
            const tel = doc.tel || doc.phone || ''
            const em = doc.em || doc.email || ''
            const sf = doc.dq_sf || doc.province || ''
            const cs = doc.dq_cs || doc.city || ''
            const yy = doc.yy || doc.hospital || ''
            const dwks = doc.dwks || doc.department || ''
            const zc = doc.zc || doc.title || ''
            const jxzc = doc.jxzc || doc.teachingTitle || ''
            const yyxzzw = doc.yyxzzw || doc.adminPosition || ''
            const shrz = doc.shrz || doc.socialPosition || ''
            const sc = doc.sc || doc.specialty || ''
            const bz = doc.bz || doc.remark || ''
            const state = doc.state || (doc.status === 'disabled' ? '停用' : '启用')
            const csrq = doc.csrq || doc.birthday || ''
            const cDate = doc.c_date || doc.createdAt || ''
            const uDate = doc.u_date || doc.updatedAt || ''

            await tx.$executeRawUnsafe(`
              INSERT INTO f_hy_ys (id, name, sex, tel, em, dq_sf, dq_cs, yy, dwks, zc, jxzc, yyxzzw, shrz, sc, bz, state, csrq, c_date, u_date)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
              ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name, sex = EXCLUDED.sex, tel = EXCLUDED.tel, em = EXCLUDED.em,
                dq_sf = EXCLUDED.dq_sf, dq_cs = EXCLUDED.dq_cs, yy = EXCLUDED.yy, dwks = EXCLUDED.dwks,
                zc = EXCLUDED.zc, jxzc = EXCLUDED.jxzc, yyxzzw = EXCLUDED.yyxzzw, shrz = EXCLUDED.shrz,
                sc = EXCLUDED.sc, bz = EXCLUDED.bz, state = EXCLUDED.state, csrq = EXCLUDED.csrq,
                c_date = EXCLUDED.c_date, u_date = EXCLUDED.u_date;
            `, docId, doc.name || '', sex, tel, em, sf, cs, yy, dwks, zc, jxzc, yyxzzw, shrz, sc, bz, state, csrq, cDate, uDate)
          }
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: '医生数据已成功保存至 PostgreSQL 数据库' }))
      } catch (err) {
        console.error('Save doctors error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: `保存医生失败: ${err.message}` }))
      }
    })
    return
  }

  // 6. 渠道管理字典 (f_hy_qd + f_hy_cp_qd)
  if ((url === '/api/v1/channels' || url === '/api/v1/channels/') && req.method === 'GET') {
    try {
      const qdList = await prisma.$queryRawUnsafe(`
        SELECT id, name, state, c_date, u_date
        FROM f_hy_qd
        ORDER BY id ASC;
      `)
      const cpList = await prisma.$queryRawUnsafe(`
        SELECT id, xh, id_yj, name, cpjg, nbyjcp, nbejcp, state, u_date
        FROM f_hy_cp_qd
        ORDER BY id_yj ASC, xh ASC;
      `)
      const cpMap = new Map()
      for (const cp of cpList) {
        if (!cpMap.has(cp.id_yj)) cpMap.set(cp.id_yj, [])
        cpMap.get(cp.id_yj).push({
          id: cp.id,
          xh: cp.xh,
          channelId: cp.id_yj,
          id_yj: cp.id_yj,
          name: cp.name,
          price: Number(cp.cpjg || 0),
          cpjg: Number(cp.cpjg || 0),
          internalLevel1: cp.nbyjcp || '',
          nbyjcp: cp.nbyjcp || '',
          internalLevel2: cp.nbejcp || '',
          nbejcp: cp.nbejcp || '',
          status: cp.state === '停用' ? 'disabled' : 'enabled',
          state: cp.state || '启用',
          updatedAt: cp.u_date || '',
          u_date: cp.u_date || ''
        })
      }
      const result = qdList.map(q => ({
        id: q.id,
        name: q.name,
        status: q.state === '停用' ? 'disabled' : 'enabled',
        state: q.state || '启用',
        createdAt: q.c_date || '',
        c_date: q.c_date || '',
        updatedAt: q.u_date || '',
        u_date: q.u_date || '',
        products: cpMap.get(q.id) || []
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: result }))
    } catch (err) {
      console.error('Fetch channels error:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: `获取渠道列表失败: ${err.message}` }))
    }
    return
  }

  if ((url === '/api/v1/channels/save' || url === '/api/v1/channels/batch' || url === '/api/v1/channels') && (req.method === 'POST' || req.method === 'PUT')) {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}')
        const channelList = Array.isArray(payload) ? payload : (payload.data || payload.channels || [])
        await prisma.$transaction(async (tx) => {
          const current = await tx.$queryRawUnsafe(`SELECT id FROM f_hy_qd`)
          const currentIds = new Set(current.map(r => r.id))
          const newIds = new Set(channelList.map(c => String(c.id).trim()))
          for (const oldId of currentIds) {
            if (!newIds.has(oldId)) {
              await tx.$executeRawUnsafe(`DELETE FROM f_hy_cp_qd WHERE id_yj = $1`, oldId)
              await tx.$executeRawUnsafe(`DELETE FROM f_hy_qd WHERE id = $1`, oldId)
            }
          }
          for (const c of channelList) {
            const cId = String(c.id).trim()
            const state = c.state || (c.status === 'disabled' ? '停用' : '启用')
            const cDate = c.c_date || c.createdAt || ''
            const uDate = c.u_date || c.updatedAt || ''

            await tx.$executeRawUnsafe(`
              INSERT INTO f_hy_qd (id, name, state, c_date, u_date)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name, state = EXCLUDED.state, c_date = EXCLUDED.c_date, u_date = EXCLUDED.u_date;
            `, cId, c.name || '', state, cDate, uDate)

            const pList = c.products || []
            const currentCp = await tx.$queryRawUnsafe(`SELECT id FROM f_hy_cp_qd WHERE id_yj = $1`, cId)
            const currentCpIds = new Set(currentCp.map(r => r.id))
            const newCpIds = new Set(pList.map(p => String(p.id).trim()))
            for (const oldCp of currentCpIds) {
              if (!newCpIds.has(oldCp)) {
                await tx.$executeRawUnsafe(`DELETE FROM f_hy_cp_qd WHERE id = $1`, oldCp)
              }
            }
            for (const p of pList) {
              const pId = String(p.id).trim()
              const xh = String(p.xh || pId.slice(-3)).trim()
              const pState = p.state || (p.status === 'disabled' ? '停用' : '启用')
              const pPrice = Number(p.price || p.cpjg || 0)
              const nbyjcp = p.nbyjcp || p.internalLevel1 || ''
              const nbejcp = p.nbejcp || p.internalLevel2 || ''
              const pUDate = p.u_date || p.updatedAt || ''

              await tx.$executeRawUnsafe(`
                INSERT INTO f_hy_cp_qd (id, xh, id_yj, name, cpjg, nbyjcp, nbejcp, state, u_date)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (id) DO UPDATE SET
                  xh = EXCLUDED.xh, name = EXCLUDED.name, cpjg = EXCLUDED.cpjg,
                  nbyjcp = EXCLUDED.nbyjcp, nbejcp = EXCLUDED.nbejcp,
                  state = EXCLUDED.state, id_yj = EXCLUDED.id_yj, u_date = EXCLUDED.u_date;
              `, pId, xh, cId, p.name || '', pPrice, nbyjcp, nbejcp, pState, pUDate)
            }
          }
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: '渠道数据已成功保存至 PostgreSQL 数据库' }))
      } catch (err) {
        console.error('Save channels error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: `保存渠道失败: ${err.message}` }))
      }
    })
    return
  }

  // 7. 对内产品字典 (f_hy_cp + f_hy_zcp)
  if ((url === '/api/v1/internal-products' || url === '/api/v1/internal-products/') && req.method === 'GET') {
    try {
      const cpList = await prisma.$queryRawUnsafe(`
        SELECT id, name, ms, lx, state, c_date, u_date
        FROM f_hy_cp
        ORDER BY id ASC;
      `)
      const zcpList = await prisma.$queryRawUnsafe(`
        SELECT id, xh, name, state, u_date, id_yj
        FROM f_hy_zcp
        ORDER BY id_yj ASC, xh ASC;
      `)
      const zcpMap = new Map()
      for (const z of zcpList) {
        if (!zcpMap.has(z.id_yj)) zcpMap.set(z.id_yj, [])
        zcpMap.get(z.id_yj).push({
          id: z.id,
          xh: z.xh,
          parentProductId: z.id_yj,
          id_yj: z.id_yj,
          name: z.name,
          status: z.state === '停用' ? 'disabled' : 'enabled',
          state: z.state || '启用',
          updatedAt: z.u_date || '',
          u_date: z.u_date || ''
        })
      }
      const result = cpList.map(c => ({
        id: c.id,
        name: c.name,
        desc: c.ms || '',
        ms: c.ms || '',
        type: c.lx || '',
        lx: c.lx || '',
        status: c.state === '停用' ? 'disabled' : 'enabled',
        state: c.state || '启用',
        createdAt: c.c_date || '',
        c_date: c.c_date || '',
        updatedAt: c.u_date || '',
        u_date: c.u_date || '',
        subProducts: zcpMap.get(c.id) || []
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: result }))
    } catch (err) {
      console.error('Fetch internal products error:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: `获取对内产品列表失败: ${err.message}` }))
    }
    return
  }

  if ((url === '/api/v1/internal-products/save' || url === '/api/v1/internal-products/batch' || url === '/api/v1/internal-products') && (req.method === 'POST' || req.method === 'PUT')) {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}')
        const productList = Array.isArray(payload) ? payload : (payload.data || payload.internalProducts || [])
        await prisma.$transaction(async (tx) => {
          const current = await tx.$queryRawUnsafe(`SELECT id FROM f_hy_cp`)
          const currentIds = new Set(current.map(r => r.id))
          const newIds = new Set(productList.map(p => String(p.id).trim()))
          for (const oldId of currentIds) {
            if (!newIds.has(oldId)) {
              await tx.$executeRawUnsafe(`DELETE FROM f_hy_zcp WHERE id_yj = $1`, oldId)
              await tx.$executeRawUnsafe(`DELETE FROM f_hy_cp WHERE id = $1`, oldId)
            }
          }
          for (const p of productList) {
            const pId = String(p.id).trim()
            const ms = p.ms || p.desc || ''
            const lx = p.lx || p.type || ''
            const state = p.state || (p.status === 'disabled' ? '停用' : '启用')
            const cDate = p.c_date || p.createdAt || ''
            const uDate = p.u_date || p.updatedAt || ''

            await tx.$executeRawUnsafe(`
              INSERT INTO f_hy_cp (id, name, ms, lx, state, c_date, u_date)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
              ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name, ms = EXCLUDED.ms, lx = EXCLUDED.lx,
                state = EXCLUDED.state, c_date = EXCLUDED.c_date, u_date = EXCLUDED.u_date;
            `, pId, p.name || '', ms, lx, state, cDate, uDate)

            const subList = p.subProducts || []
            const currentZ = await tx.$queryRawUnsafe(`SELECT id FROM f_hy_zcp WHERE id_yj = $1`, pId)
            const currentZIds = new Set(currentZ.map(r => r.id))
            const newZIds = new Set(subList.map(s => String(s.id).trim()))
            for (const oldZ of currentZIds) {
              if (!newZIds.has(oldZ)) {
                await tx.$executeRawUnsafe(`DELETE FROM f_hy_zcp WHERE id = $1`, oldZ)
              }
            }
            for (const sub of subList) {
              const sId = String(sub.id).trim()
              const xh = String(sub.xh || sId.slice(-4)).trim()
              const sState = sub.state || (sub.status === 'disabled' ? '停用' : '启用')
              const sUDate = sub.u_date || sub.updatedAt || ''

              await tx.$executeRawUnsafe(`
                INSERT INTO f_hy_zcp (id, xh, name, state, u_date, id_yj)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT (id) DO UPDATE SET
                  xh = EXCLUDED.xh, name = EXCLUDED.name,
                  state = EXCLUDED.state, u_date = EXCLUDED.u_date, id_yj = EXCLUDED.id_yj;
              `, sId, xh, sub.name || '', sState, sUDate, pId)
            }
          }
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: '对内产品数据已成功保存至 PostgreSQL 数据库' }))
      } catch (err) {
        console.error('Save internal products error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: `保存对内产品失败: ${err.message}` }))
      }
    })
    return
  }

  // 8. 支付渠道字典 (zfqd)
  if ((url === '/api/v1/payment-channels' || url === '/api/v1/payment-channels/') && req.method === 'GET') {
    try {
      const zfList = await prisma.$queryRawUnsafe(`
        SELECT id, name, yy, start, u_date, zf_id, by1, by2
        FROM zfqd
        ORDER BY id ASC;
      `)
      const result = zfList.map(z => ({
        id: z.id,
        name: z.name || '',
        hospital: z.yy || '',
        yy: z.yy || '',
        status: z.start === '停用' ? 'disabled' : 'enabled',
        start: z.start || '启用',
        state: z.start || '启用',
        updatedAt: z.u_date || '',
        u_date: z.u_date || '',
        merchantId: z.zf_id || '',
        zf_id: z.zf_id || '',
        by1: z.by1 || '',
        by2: z.by2 || ''
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: result }))
    } catch (err) {
      console.error('Fetch payment channels error:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: `获取支付渠道列表失败: ${err.message}` }))
    }
    return
  }

  if ((url === '/api/v1/payment-channels/save' || url === '/api/v1/payment-channels/batch' || url === '/api/v1/payment-channels') && (req.method === 'POST' || req.method === 'PUT')) {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}')
        const payList = Array.isArray(payload) ? payload : (payload.data || payload.paymentChannels || [])
        await prisma.$transaction(async (tx) => {
          const current = await tx.$queryRawUnsafe(`SELECT id FROM zfqd`)
          const currentIds = new Set(current.map(r => r.id))
          const newIds = new Set(payList.map(p => String(p.id).trim()))
          for (const oldId of currentIds) {
            if (!newIds.has(oldId)) {
              await tx.$executeRawUnsafe(`DELETE FROM zfqd WHERE id = $1`, oldId)
            }
          }
          for (const p of payList) {
            const pId = String(p.id).trim()
            const yy = p.yy || p.hospital || ''
            const start = p.start || (p.status === 'disabled' ? '停用' : '启用')
            const uDate = p.u_date || p.updatedAt || ''
            const zfId = p.zf_id || p.merchantId || ''
            const by1 = p.by1 || ''
            const by2 = p.by2 || ''

            await tx.$executeRawUnsafe(`
              INSERT INTO zfqd (id, name, yy, start, u_date, zf_id, by1, by2)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name, yy = EXCLUDED.yy, start = EXCLUDED.start,
                u_date = EXCLUDED.u_date, zf_id = EXCLUDED.zf_id, by1 = EXCLUDED.by1, by2 = EXCLUDED.by2;
            `, pId, p.name || '', yy, start, uDate, zfId, by1, by2)
          }
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: '支付渠道数据已成功保存至 PostgreSQL 数据库' }))
      } catch (err) {
        console.error('Save payment channels error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: `保存支付渠道失败: ${err.message}` }))
      }
    })
    return
  }

  // 9. 陪诊人员字典 (f_hy_pzr)
  if ((url === '/api/v1/escorts' || url === '/api/v1/escorts/') && req.method === 'GET') {
    try {
      const escorts = await prisma.$queryRawUnsafe(`
        SELECT id, name, xb, sj, sf, cs, bz, state, c_date, u_date, pzrlx
        FROM f_hy_pzr
        ORDER BY id ASC;
      `)
      const result = escorts.map(e => ({
        id: e.id,
        name: e.name || '',
        gender: e.xb || '男',
        xb: e.xb || '男',
        phone: e.sj || '',
        sj: e.sj || '',
        provinceCode: e.sf || '',
        sf: e.sf || '',
        cityCode: e.cs || '',
        cs: e.cs || '',
        remark: e.bz || '',
        bz: e.bz || '',
        status: e.state === '停用' ? 'disabled' : 'enabled',
        state: e.state || '启用',
        createdAt: e.c_date || '',
        c_date: e.c_date || '',
        updatedAt: e.u_date || '',
        u_date: e.u_date || '',
        type: e.pzrlx || '外包',
        pzrlx: e.pzrlx || '外包'
      }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: result }))
    } catch (err) {
      console.error('Fetch escorts error:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: `获取陪诊人员列表失败: ${err.message}` }))
    }
    return
  }

  if ((url === '/api/v1/escorts/save' || url === '/api/v1/escorts/batch' || url === '/api/v1/escorts') && (req.method === 'POST' || req.method === 'PUT')) {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}')
        const escortList = Array.isArray(payload) ? payload : (payload.data || payload.escorts || [])
        await prisma.$transaction(async (tx) => {
          const current = await tx.$queryRawUnsafe(`SELECT id FROM f_hy_pzr`)
          const currentIds = new Set(current.map(r => r.id))
          const newIds = new Set(escortList.map(e => String(e.id).trim()))
          for (const oldId of currentIds) {
            if (!newIds.has(oldId)) {
              await tx.$executeRawUnsafe(`DELETE FROM f_hy_pzr WHERE id = $1`, oldId)
            }
          }
          for (const e of escortList) {
            const eId = String(e.id).trim()
            const xb = e.xb || e.gender || '男'
            const sj = e.sj || e.phone || ''
            const sf = e.sf || e.provinceCode || ''
            const cs = e.cs || e.cityCode || ''
            const bz = e.bz || e.remark || ''
            const state = e.state || (e.status === 'disabled' ? '停用' : '启用')
            const cDate = e.c_date || e.createdAt || ''
            const uDate = e.u_date || e.updatedAt || ''
            const pzrlx = e.pzrlx || e.type || '外包'

            await tx.$executeRawUnsafe(`
              INSERT INTO f_hy_pzr (id, name, xb, sj, sf, cs, bz, state, c_date, u_date, pzrlx)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
              ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name, xb = EXCLUDED.xb, sj = EXCLUDED.sj,
                sf = EXCLUDED.sf, cs = EXCLUDED.cs, bz = EXCLUDED.bz,
                state = EXCLUDED.state, c_date = EXCLUDED.c_date, u_date = EXCLUDED.u_date,
                pzrlx = EXCLUDED.pzrlx;
            `, eId, e.name || '', xb, sj, sf, cs, bz, state, cDate, uDate, pzrlx)
          }
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, message: '陪诊人员数据已成功保存至 PostgreSQL 数据库' }))
      } catch (err) {
        console.error('Save escorts error:', err)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: `保存陪诊人员失败: ${err.message}` }))
      }
    })
    return
  }

  // 10. 城市列表维度字典 (dim_cslb)
  if ((url === '/api/v1/regions' || url === '/api/v1/regions/' || url === '/api/v1/dim_cslb') && req.method === 'GET') {
    try {
      const cslb = await prisma.$queryRawUnsafe(`
        SELECT s_id, s_name, x_id, x_name
        FROM dim_cslb
        ORDER BY s_id ASC, x_id ASC;
      `)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: cslb }))
    } catch (err) {
      console.error('Fetch dim_cslb error:', err)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: `获取省市列表失败: ${err.message}` }))
    }
    return
  }

  // 11. 健康检查接口
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'OK', localDb: 'PostgreSQL-16', port: 15432, timestamp: new Date().toISOString() }))
    return
  }

  // 12. 其他业务接口代理转发至远程服务器
  const targetUrl = `${REMOTE_BACKEND}${url}`
  const proxyReq = http.request(targetUrl, {
    method: req.method,
    headers: { ...req.headers, host: '47.95.14.233:9093' }
  }, proxyRes => {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers)
    proxyRes.pipe(res)
  })

  proxyReq.on('error', err => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `代理转发失败: ${err.message}` }))
    }
  })

  req.on('error', err => {
    console.error('Request stream error:', err)
  })

  res.on('error', err => {
    console.error('Response stream error:', err)
  })

  req.pipe(proxyReq)
})

process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err)
})

process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason)
})

autoInitDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`✅ 本地后端服务已启动并连接本地 PostgreSQL 数据库: http://localhost:${PORT}`)
  })
})
