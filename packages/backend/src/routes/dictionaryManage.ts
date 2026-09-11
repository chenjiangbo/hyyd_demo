import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { PrismaClient } from '@prisma/client'

export function registerDictionaryManageRoutes(fastify: FastifyInstance, prisma: PrismaClient) {
  // 1. 对内科室字典 (f_hy_kswh + f_hy_xfks)
  fastify.get('/api/v1/departments', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const yjList = await prisma.$queryRawUnsafe<any[]>(`
        SELECT id, name, ms, state, c_date, u_date
        FROM f_hy_kswh
        ORDER BY id ASC;
      `)
      const ejList = await prisma.$queryRawUnsafe<any[]>(`
        SELECT id, xh, name_yjks, name, state, u_date
        FROM f_hy_xfks
        ORDER BY name_yjks ASC, xh ASC;
      `)
      const ejMap = new Map<string, any[]>()
      for (const ej of ejList) {
        if (!ejMap.has(ej.name_yjks)) ejMap.set(ej.name_yjks, [])
        ejMap.get(ej.name_yjks)!.push(ej)
      }
      const result = yjList.map(yj => ({
        ...yj,
        subDepartments: ejMap.get(yj.id) || []
      }))
      return reply.send({ ok: true, data: result })
    } catch (err: any) {
      fastify.log.error('Fetch departments error:', err)
      return reply.status(500).send({ ok: false, error: `获取科室列表失败: ${err.message}` })
    }
  })

  const handleSaveDepartments = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = (request.body as any) || {}
      const deptList = Array.isArray(payload) ? payload : (payload.data || payload.departments || [])
      await prisma.$transaction(async (tx) => {
        const currentYj = await tx.$queryRawUnsafe<any[]>(`SELECT id FROM f_hy_kswh`)
        const currentYjIds = new Set(currentYj.map(r => r.id))
        const newYjIds = new Set(deptList.map((d: any) => String(d.id).trim()))
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
          const currentEj = await tx.$queryRawUnsafe<any[]>(`SELECT id FROM f_hy_xfks WHERE name_yjks = $1`, dId)
          const currentEjIds = new Set(currentEj.map(r => r.id))
          const newEjIds = new Set(subList.map((s: any) => String(s.id).trim()))
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
      return reply.send({ ok: true, message: '科室数据已成功保存至 PostgreSQL 数据库' })
    } catch (err: any) {
      fastify.log.error('Save departments error:', err)
      return reply.status(500).send({ ok: false, error: `保存科室失败: ${err.message}` })
    }
  }

  fastify.post('/api/v1/departments/save', handleSaveDepartments)
  fastify.post('/api/v1/departments/batch', handleSaveDepartments)
  fastify.post('/api/v1/departments', handleSaveDepartments)
  fastify.put('/api/v1/departments', handleSaveDepartments)

  // 2. 医院管理字典 (f_hy_yywh + f_hy_yy_ks)
  fastify.get('/api/v1/hospitals', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const hList = await prisma.$queryRawUnsafe<any[]>(`
        SELECT id, name, level, bq, dq, dz, tips, bz, state, dz1, dz2, dq_sf, dq_cs, dz3, u_date
        FROM f_hy_yywh
        ORDER BY id ASC;
      `)
      const dwList = await prisma.$queryRawUnsafe<any[]>(`
        SELECT id, xh, id_yy, name, ksdl, ksxf, state, u_date
        FROM f_hy_yy_ks
        ORDER BY id_yy ASC, xh ASC;
      `)
      const dwMap = new Map<string, any[]>()
      for (const dw of dwList) {
        if (!dwMap.has(dw.id_yy)) dwMap.set(dw.id_yy, [])
        dwMap.get(dw.id_yy)!.push(dw)
      }
      const result = hList.map(h => ({
        ...h,
        externalDepartments: dwMap.get(h.id) || []
      }))
      return reply.send({ ok: true, data: result })
    } catch (err: any) {
      fastify.log.error('Fetch hospitals error:', err)
      return reply.status(500).send({ ok: false, error: `获取医院列表失败: ${err.message}` })
    }
  })

  const handleSaveHospitals = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = (request.body as any) || {}
      const hList = Array.isArray(payload) ? payload : (payload.data || payload.hospitals || [])
      await prisma.$transaction(async (tx) => {
        const currentH = await tx.$queryRawUnsafe<any[]>(`SELECT id FROM f_hy_yywh`)
        const currentHIds = new Set(currentH.map(r => r.id))
        const newHIds = new Set(hList.map((h: any) => String(h.id).trim()))
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
          const currentDw = await tx.$queryRawUnsafe<any[]>(`SELECT id FROM f_hy_yy_ks WHERE id_yy = $1`, hId)
          const currentDwIds = new Set(currentDw.map(r => r.id))
          const newDwIds = new Set(extList.map((d: any) => String(d.id).trim()))
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
      return reply.send({ ok: true, message: '医院数据已成功保存至 PostgreSQL 数据库' })
    } catch (err: any) {
      fastify.log.error('Save hospitals error:', err)
      return reply.status(500).send({ ok: false, error: `保存医院失败: ${err.message}` })
    }
  }

  fastify.post('/api/v1/hospitals/save', handleSaveHospitals)
  fastify.post('/api/v1/hospitals/batch', handleSaveHospitals)
  fastify.post('/api/v1/hospitals', handleSaveHospitals)
  fastify.put('/api/v1/hospitals', handleSaveHospitals)

  // 3. 医生档案字典 (f_hy_ys)
  fastify.get('/api/v1/doctors', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const ysList = await prisma.$queryRawUnsafe<any[]>(`
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
      return reply.send({ ok: true, data: result })
    } catch (err: any) {
      fastify.log.error('Fetch doctors error:', err)
      return reply.status(500).send({ ok: false, error: `获取医生列表失败: ${err.message}` })
    }
  })

  const handleSaveDoctors = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = (request.body as any) || {}
      const doctorList = Array.isArray(payload) ? payload : (payload.data || payload.doctors || [])
      await prisma.$transaction(async (tx) => {
        const current = await tx.$queryRawUnsafe<any[]>(`SELECT id FROM f_hy_ys`)
        const currentIds = new Set(current.map(r => r.id))
        const newIds = new Set(doctorList.map((d: any) => String(d.id).trim()))
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
      return reply.send({ ok: true, message: '医生数据已成功保存至 PostgreSQL 数据库' })
    } catch (err: any) {
      fastify.log.error('Save doctors error:', err)
      return reply.status(500).send({ ok: false, error: `保存医生失败: ${err.message}` })
    }
  }

  fastify.post('/api/v1/doctors/save', handleSaveDoctors)
  fastify.post('/api/v1/doctors/batch', handleSaveDoctors)
  fastify.post('/api/v1/doctors', handleSaveDoctors)
  fastify.put('/api/v1/doctors', handleSaveDoctors)

  // 4. 渠道管理字典 (f_hy_qd + f_hy_cp_qd)
  fastify.get('/api/v1/channels', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const qdList = await prisma.$queryRawUnsafe<any[]>(`
        SELECT id, name, state, c_date, u_date
        FROM f_hy_qd
        ORDER BY id ASC;
      `)
      const cpList = await prisma.$queryRawUnsafe<any[]>(`
        SELECT id, xh, id_yj, name, cpjg, nbyjcp, nbejcp, state, u_date
        FROM f_hy_cp_qd
        ORDER BY id_yj ASC, xh ASC;
      `)
      const cpMap = new Map<string, any[]>()
      for (const cp of cpList) {
        if (!cpMap.has(cp.id_yj)) cpMap.set(cp.id_yj, [])
        cpMap.get(cp.id_yj)!.push({
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
      return reply.send({ ok: true, data: result })
    } catch (err: any) {
      fastify.log.error('Fetch channels error:', err)
      return reply.status(500).send({ ok: false, error: `获取渠道列表失败: ${err.message}` })
    }
  })

  const handleSaveChannels = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = (request.body as any) || {}
      const channelList = Array.isArray(payload) ? payload : (payload.data || payload.channels || [])
      await prisma.$transaction(async (tx) => {
        const current = await tx.$queryRawUnsafe<any[]>(`SELECT id FROM f_hy_qd`)
        const currentIds = new Set(current.map(r => r.id))
        const newIds = new Set(channelList.map((c: any) => String(c.id).trim()))
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
          const currentCp = await tx.$queryRawUnsafe<any[]>(`SELECT id FROM f_hy_cp_qd WHERE id_yj = $1`, cId)
          const currentCpIds = new Set(currentCp.map(r => r.id))
          const newCpIds = new Set(pList.map((p: any) => String(p.id).trim()))
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
      return reply.send({ ok: true, message: '渠道数据已成功保存至 PostgreSQL 数据库' })
    } catch (err: any) {
      fastify.log.error('Save channels error:', err)
      return reply.status(500).send({ ok: false, error: `保存渠道失败: ${err.message}` })
    }
  }

  fastify.post('/api/v1/channels/save', handleSaveChannels)
  fastify.post('/api/v1/channels/batch', handleSaveChannels)
  fastify.post('/api/v1/channels', handleSaveChannels)
  fastify.put('/api/v1/channels', handleSaveChannels)

  // 5. 对内产品字典 (f_hy_cp + f_hy_zcp)
  fastify.get('/api/v1/internal-products', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const cpList = await prisma.$queryRawUnsafe<any[]>(`
        SELECT id, name, ms, lx, state, c_date, u_date
        FROM f_hy_cp
        ORDER BY id ASC;
      `)
      const zcpList = await prisma.$queryRawUnsafe<any[]>(`
        SELECT id, xh, name, state, u_date, id_yj
        FROM f_hy_zcp
        ORDER BY id_yj ASC, xh ASC;
      `)
      const zcpMap = new Map<string, any[]>()
      for (const z of zcpList) {
        if (!zcpMap.has(z.id_yj)) zcpMap.set(z.id_yj, [])
        zcpMap.get(z.id_yj)!.push({
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
      return reply.send({ ok: true, data: result })
    } catch (err: any) {
      fastify.log.error('Fetch internal products error:', err)
      return reply.status(500).send({ ok: false, error: `获取对内产品列表失败: ${err.message}` })
    }
  })

  const handleSaveInternalProducts = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = (request.body as any) || {}
      const productList = Array.isArray(payload) ? payload : (payload.data || payload.internalProducts || [])
      await prisma.$transaction(async (tx) => {
        const current = await tx.$queryRawUnsafe<any[]>(`SELECT id FROM f_hy_cp`)
        const currentIds = new Set(current.map(r => r.id))
        const newIds = new Set(productList.map((p: any) => String(p.id).trim()))
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
          const currentZ = await tx.$queryRawUnsafe<any[]>(`SELECT id FROM f_hy_zcp WHERE id_yj = $1`, pId)
          const currentZIds = new Set(currentZ.map(r => r.id))
          const newZIds = new Set(subList.map((s: any) => String(s.id).trim()))
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
      return reply.send({ ok: true, message: '对内产品数据已成功保存至 PostgreSQL 数据库' })
    } catch (err: any) {
      fastify.log.error('Save internal products error:', err)
      return reply.status(500).send({ ok: false, error: `保存对内产品失败: ${err.message}` })
    }
  }

  fastify.post('/api/v1/internal-products/save', handleSaveInternalProducts)
  fastify.post('/api/v1/internal-products/batch', handleSaveInternalProducts)
  fastify.post('/api/v1/internal-products', handleSaveInternalProducts)
  fastify.put('/api/v1/internal-products', handleSaveInternalProducts)

  // 6. 支付渠道字典 (zfqd)
  fastify.get('/api/v1/payment-channels', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const zfList = await prisma.$queryRawUnsafe<any[]>(`
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
      return reply.send({ ok: true, data: result })
    } catch (err: any) {
      fastify.log.error('Fetch payment channels error:', err)
      return reply.status(500).send({ ok: false, error: `获取支付渠道列表失败: ${err.message}` })
    }
  })

  const handleSavePaymentChannels = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = (request.body as any) || {}
      const payList = Array.isArray(payload) ? payload : (payload.data || payload.paymentChannels || [])
      await prisma.$transaction(async (tx) => {
        const current = await tx.$queryRawUnsafe<any[]>(`SELECT id FROM zfqd`)
        const currentIds = new Set(current.map(r => r.id))
        const newIds = new Set(payList.map((p: any) => String(p.id).trim()))
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
      return reply.send({ ok: true, message: '支付渠道数据已成功保存至 PostgreSQL 数据库' })
    } catch (err: any) {
      fastify.log.error('Save payment channels error:', err)
      return reply.status(500).send({ ok: false, error: `保存支付渠道失败: ${err.message}` })
    }
  }

  fastify.post('/api/v1/payment-channels/save', handleSavePaymentChannels)
  fastify.post('/api/v1/payment-channels/batch', handleSavePaymentChannels)
  fastify.post('/api/v1/payment-channels', handleSavePaymentChannels)
  fastify.put('/api/v1/payment-channels', handleSavePaymentChannels)

  // 7. 陪诊人员字典 (f_hy_pzr)
  fastify.get('/api/v1/escorts', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const escorts = await prisma.$queryRawUnsafe<any[]>(`
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
      return reply.send({ ok: true, data: result })
    } catch (err: any) {
      fastify.log.error('Fetch escorts error:', err)
      return reply.status(500).send({ ok: false, error: `获取陪诊人员列表失败: ${err.message}` })
    }
  })

  const handleSaveEscorts = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = (request.body as any) || {}
      const escortList = Array.isArray(payload) ? payload : (payload.data || payload.escorts || [])
      await prisma.$transaction(async (tx) => {
        const current = await tx.$queryRawUnsafe<any[]>(`SELECT id FROM f_hy_pzr`)
        const currentIds = new Set(current.map(r => r.id))
        const newIds = new Set(escortList.map((e: any) => String(e.id).trim()))
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
      return reply.send({ ok: true, message: '陪诊人员数据已成功保存至 PostgreSQL 数据库' })
    } catch (err: any) {
      fastify.log.error('Save escorts error:', err)
      return reply.status(500).send({ ok: false, error: `保存陪诊人员失败: ${err.message}` })
    }
  }

  fastify.post('/api/v1/escorts/save', handleSaveEscorts)
  fastify.post('/api/v1/escorts/batch', handleSaveEscorts)
  fastify.post('/api/v1/escorts', handleSaveEscorts)
  fastify.put('/api/v1/escorts', handleSaveEscorts)

  // 8. 城市列表维度字典 (dim_cslb)
  const handleGetRegions = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const cslb = await prisma.$queryRawUnsafe<any[]>(`
        SELECT s_id, s_name, x_id, x_name
        FROM dim_cslb
        ORDER BY s_id ASC, x_id ASC;
      `)
      return reply.send({ ok: true, data: cslb })
    } catch (err: any) {
      fastify.log.error('Fetch dim_cslb error:', err)
      return reply.status(500).send({ ok: false, error: `获取省市列表失败: ${err.message}` })
    }
  }

  fastify.get('/api/v1/regions', handleGetRegions)
  fastify.get('/api/v1/dim_cslb', handleGetRegions)
}
