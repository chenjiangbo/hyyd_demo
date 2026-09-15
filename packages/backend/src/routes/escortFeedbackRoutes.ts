import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { PrismaClient } from '@prisma/client'
import * as Minio from 'minio'
import { listHuanyuEscorts } from '../db/remoteDictionary.js'

interface EscortFeedbackInfoQuery {
  orderNo?: string
  type?: string
}

interface EscortFeedbackSubmitBody {
  orderNo: string
  pzrId?: string
  pzrName?: string
  pzr?: string
  feedbackType: 'pre_day' | 'same_day'
  willAttend: boolean
  screenshotUrl?: string
  remark?: string
}

interface UploadBody {
  image: string
  fileName?: string
}

export function registerEscortFeedbackRoutes(
  fastify: FastifyInstance,
  prisma: PrismaClient,
  minioClient?: Minio.Client,
  minioPublicClient?: Minio.Client
): void {
  // 1. 获取订单与历史反馈信息
  fastify.get<{ Querystring: EscortFeedbackInfoQuery }>(
    '/api/v1/escort-feedback/info',
    async (request: FastifyRequest<{ Querystring: EscortFeedbackInfoQuery }>, reply: FastifyReply) => {
      const { orderNo, type = 'pre_day' } = request.query
      if (!orderNo || !orderNo.trim()) {
        return reply.status(400).send({ error: 'orderNo 必填' })
      }

      const cleanOrderNo = orderNo.trim()

      // 查询订单基础信息
      const order = await prisma.order.findFirst({
        where: {
          OR: [{ sourceOrderNo: cleanOrderNo }, { huanyuOrderNo: cleanOrderNo }]
        },
        include: { assignedEmployee: true }
      })

      // 查询寰宇订单表与陪诊人指派信息
      const huanyuRows = await prisma.$queryRawUnsafe<any[]>(`
        SELECT 
          h."DDBH", h."BDQD_DDBH", h."JZR_XM", h."H_NAME", h."H_KS", h."H_YS",
          COALESCE(p."PZR", h."PZR") AS pzr_id,
          COALESCE(p."BBQ_FW", h."BBQ_FW", h."DATE_FW") AS service_date
        FROM "HY_FACT_DDCX_NEW" h
        LEFT JOIN "fact_hy_pzrxx" p ON (p."DDBH" = h."DDBH" OR p."DDBH" = h."BDQD_DDBH")
        WHERE h."BDQD_DDBH" = $1 OR h."DDBH" = $1
        LIMIT 1;
      `, cleanOrderNo)

      const hy = huanyuRows[0] || {}

      const customerName = order?.customerName || hy.JZR_XM || '客户'
      const hospital = order?.hospital || hy.H_NAME || '待定医院'
      const dept = order?.dept || hy.H_KS || ''
      const pzrId = hy.pzr_id || ''
      let pzrName = pzrId || '陪诊人员'
      let escortPhone = ''

      // 从远端 MySQL 字典库 (dim_hy_pzr) 获取陪诊人姓名与默认手机号
      if (pzrId) {
        try {
          const escorts = await listHuanyuEscorts(pzrId)
          const matched = escorts.find((e) => e.id === pzrId) || escorts[0]
          if (matched) {
            pzrName = matched.name || pzrId
            escortPhone = matched.phone || ''
          }
        } catch {
          // 远端 MySQL 异常时使用本地编号作为 fallback
        }
      }

      const serviceDate = hy.service_date || ''
      const sourceOrderNo = order?.sourceOrderNo || hy.BDQD_DDBH || cleanOrderNo
      const huanyuOrderNo = order?.huanyuOrderNo || hy.DDBH || ''

      // 查询最新的一条同类型反馈记录
      const feedbacks = await prisma.$queryRawUnsafe<any[]>(`
        SELECT id, ddbh, pzr_id, pzr_name, feedback_type, will_attend, screenshot_url, remark, created_at
        FROM "fact_hy_pzfk"
        WHERE (ddbh = $1 OR ddbh = $2) AND feedback_type = $3
        ORDER BY created_at DESC
        LIMIT 1;
      `, sourceOrderNo, huanyuOrderNo, type)

      const existingFeedback = feedbacks[0]
        ? {
            id: feedbacks[0].id,
            pzrId: feedbacks[0].pzr_id,
            pzrName: feedbacks[0].pzr_name,
            willAttend: feedbacks[0].will_attend,
            screenshotUrl: feedbacks[0].screenshot_url,
            remark: feedbacks[0].remark,
            createdAt: feedbacks[0].created_at
          }
        : null

      return reply.send({
        data: {
          orderNo: sourceOrderNo,
          huanyuOrderNo,
          customerName,
          hospital,
          dept,
          pzrId,
          pzrName,
          pzr: pzrName,
          phone: escortPhone,
          serviceDate,
          feedbackType: type,
          existingFeedback
        }
      })
    }
  )

  // 2. 提交出工反馈
  fastify.post<{ Body: EscortFeedbackSubmitBody }>(
    '/api/v1/escort-feedback/submit',
    async (request: FastifyRequest<{ Body: EscortFeedbackSubmitBody }>, reply: FastifyReply) => {
      const { orderNo, pzrId, pzrName, pzr, feedbackType, willAttend, screenshotUrl, remark } = request.body || ({} as EscortFeedbackSubmitBody)

      if (!orderNo || !feedbackType) {
        return reply.status(400).send({ error: 'orderNo 与 feedbackType 必填' })
      }

      if (willAttend === false && (!remark || !remark.trim())) {
        return reply.status(400).send({ error: '选择无法出工时，必须填写原因' })
      }

      const cleanOrderNo = orderNo.trim()
      const effectiveType = feedbackType === 'same_day' ? 'same_day' : 'pre_day'
      const effectivePzrId = pzrId || pzr || null
      const effectivePzrName = pzrName || pzr || null

      const result = await prisma.$queryRawUnsafe<any[]>(`
        INSERT INTO "fact_hy_pzfk" (
          ddbh, pzr_id, pzr_name, feedback_type, will_attend, screenshot_url, remark, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, NOW()
        ) RETURNING id, created_at;
      `, cleanOrderNo, effectivePzrId, effectivePzrName, effectiveType, Boolean(willAttend), screenshotUrl || null, remark ? remark.trim() : null)

      fastify.log.info(
        `[escortFeedback] 订单 ${cleanOrderNo} 收到 ${effectiveType} 反馈: willAttend=${willAttend}, pzrId=${effectivePzrId}, pzrName=${effectivePzrName}`
      )

      return reply.send({
        data: {
          success: true,
          id: result[0]?.id,
          createdAt: result[0]?.created_at
        }
      })
    }
  )

  // 3. 上传联系客户截图
  fastify.post<{ Body: UploadBody }>(
    '/api/v1/escort-feedback/upload',
    async (request: FastifyRequest<{ Body: UploadBody }>, reply: FastifyReply) => {
      const { image } = request.body || {}
      if (!image) {
        return reply.status(400).send({ error: '缺少图片数据' })
      }

      try {
        const matches = image.match(/^data:([A-Za-z-+/]+);base64,(.+)$/)
        const buffer = matches ? Buffer.from(matches[2], 'base64') : Buffer.from(image, 'base64')
        const ext = matches ? (matches[1].split('/')[1] || 'jpg') : 'jpg'
        const objectKey = `escort-feedbacks/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`

        if (minioClient) {
          const bucket = 'screenshots'
          await minioClient.putObject(bucket, objectKey, buffer, buffer.length, {
            'Content-Type': matches ? matches[1] : 'image/jpeg'
          })

          const publicUrl = minioPublicClient
            ? await minioPublicClient.presignedGetObject(bucket, objectKey, 7 * 24 * 3600)
            : `/api/v1/screenshots/${objectKey}`

          return reply.send({ data: { url: publicUrl, key: objectKey } })
        } else {
          return reply.send({ data: { url: image } })
        }
      } catch (err: any) {
        fastify.log.error('上传联系客户截图失败:', err)
        return reply.send({ data: { url: image } })
      }
    }
  )

  // 4. H5 移动端极简反馈页面
  fastify.get(
    '/m/escort-feedback',
    async (request: FastifyRequest<{ Querystring: EscortFeedbackInfoQuery }>, reply: FastifyReply) => {
      const orderNo = request.query.orderNo || ''
      const type = request.query.type || 'pre_day'

      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>陪诊人员出工确认</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #f3f4f6;
      color: #1f2937;
      line-height: 1.5;
      padding: 16px;
      max-width: 540px;
      margin: 0 auto;
    }
    .header {
      background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%);
      color: white;
      padding: 20px 16px;
      border-radius: 12px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
      margin-bottom: 16px;
    }
    .header h1 { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
    .header p { font-size: 13px; opacity: 0.9; }

    .card {
      background: white;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .card-title {
      font-size: 14px;
      font-weight: 600;
      color: #4b5563;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      padding: 6px 0;
      font-size: 13px;
      border-bottom: 1px dashed #f3f4f6;
    }
    .info-label { color: #6b7280; flex-shrink: 0; }
    .info-val { font-weight: 500; color: #111827; text-align: right; }

    .radio-group {
      display: flex;
      gap: 12px;
      margin-top: 8px;
    }
    .radio-card {
      flex: 1;
      border: 2px solid #e5e7eb;
      border-radius: 10px;
      padding: 14px 10px;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s;
    }
    .radio-card.active-yes {
      border-color: #0284c7;
      background-color: #f0f9ff;
      color: #0369a1;
      font-weight: 600;
    }
    .radio-card.active-no {
      border-color: #ef4444;
      background-color: #fef2f2;
      color: #b91c1c;
      font-weight: 600;
    }

    .form-group {
      margin-top: 14px;
    }
    .form-label {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 6px;
      display: block;
      color: #374151;
    }
    .required { color: #ef4444; }
    .input-text, textarea {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    .input-text:focus, textarea:focus {
      border-color: #0284c7;
    }

    .upload-box {
      border: 2px dashed #cbd5e1;
      border-radius: 8px;
      padding: 16px;
      text-align: center;
      background: #f8fafc;
      cursor: pointer;
      position: relative;
    }
    .upload-box input[type="file"] {
      position: absolute;
      left: 0; top: 0; width: 100%; height: 100%;
      opacity: 0;
      cursor: pointer;
    }
    .preview-container {
      margin-top: 10px;
      position: relative;
      display: inline-block;
    }
    .preview-img {
      max-width: 100%;
      max-height: 200px;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
      display: block;
    }
    .remove-btn {
      position: absolute;
      top: -8px; right: -8px;
      background: #ef4444;
      color: white;
      border-radius: 50%;
      width: 22px; height: 22px;
      border: none;
      font-size: 12px;
      cursor: pointer;
    }

    .btn-submit {
      width: 100%;
      background: #0284c7;
      color: white;
      border: none;
      padding: 14px;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 2px 4px rgba(2, 132, 199, 0.3);
      margin-top: 16px;
    }
    .btn-submit:disabled {
      background: #9ca3af;
      cursor: not-allowed;
      box-shadow: none;
    }

    .success-card {
      background: #ecfdf5;
      border: 1px solid #a7f3d0;
      color: #065f46;
      border-radius: 12px;
      padding: 20px;
      text-align: center;
      margin-top: 20px;
    }
    .success-icon { font-size: 36px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="header">
    <h1 id="pageTitle">陪诊人员出工确认</h1>
    <p id="pageSubtitle">请如实反馈您的出工状态与沟通情况</p>
  </div>

  <div id="loading" style="text-align: center; padding: 40px; color: #6b7280;">
    正在加载订单信息...
  </div>

  <div id="content" style="display: none;">
    <!-- 订单信息卡片 -->
    <div class="card">
      <div class="card-title">📋 陪诊任务信息</div>
      <div class="info-row">
        <span class="info-label">订单号</span>
        <span class="info-val" id="dispOrderNo">-</span>
      </div>
      <div class="info-row">
        <span class="info-label">就诊人</span>
        <span class="info-val" id="dispCustomer">-</span>
      </div>
      <div class="info-row">
        <span class="info-label">服务医院</span>
        <span class="info-val" id="dispHospital">-</span>
      </div>
      <div class="info-row">
        <span class="info-label">服务时间</span>
        <span class="info-val" id="dispServiceDate" style="color: #0284c7; font-weight: 600;">-</span>
      </div>
      <div class="info-row">
        <span class="info-label">陪诊人员</span>
        <span class="info-val" id="dispPzr">-</span>
      </div>
    </div>

    <!-- 已提交状态 -->
    <div id="submittedCard" class="success-card" style="display: none;">
      <div class="success-icon">✅</div>
      <h3 style="font-size: 16px; font-weight: 600; margin-bottom: 4px;">出工状态已反馈</h3>
      <p id="submittedDesc" style="font-size: 13px; color: #047857;"></p>
    </div>

    <!-- 反馈表单 -->
    <div id="formCard" class="card">
      <div class="card-title">📝 反馈本次出工情况</div>

      <div class="form-group">
        <label class="form-label">是否出工 <span class="required">*</span></label>
        <div class="radio-group">
          <div id="btnAttendYes" class="radio-card active-yes" onclick="setAttend(true)">
            <div style="font-size: 16px; margin-bottom: 2px;">✅ 确认出工</div>
            <div style="font-size: 11px; opacity: 0.8;">准时出工服务</div>
          </div>
          <div id="btnAttendNo" class="radio-card" onclick="setAttend(false)">
            <div style="font-size: 16px; margin-bottom: 2px;">❌ 无法出工</div>
            <div style="font-size: 11px; opacity: 0.8;">突发异常报备</div>
          </div>
        </div>
      </div>

      <!-- 联系客户截图上传 -->
      <div id="screenshotGroup" class="form-group">
        <label class="form-label">上传联系客户截图 <span class="required" id="screenshotReqMark">*</span></label>
        <p style="font-size: 12px; color: #6b7280; margin-bottom: 6px;">请上传您与客户微信/短信/通话沟通的确认截图</p>
        <div class="upload-box">
          <input type="file" id="fileInput" accept="image/*" onchange="handleFileSelect(event)">
          <div id="uploadPrompt" style="color: #64748b; font-size: 13px;">
            📷 点击选择图片或拍照上传
          </div>
          <div id="previewWrap" class="preview-container" style="display: none;">
            <img id="previewImg" class="preview-img" src="" alt="截图预览">
            <button type="button" class="remove-btn" onclick="removeImage(event)">✕</button>
          </div>
        </div>
      </div>

      <!-- 备注 / 无法出工原因 -->
      <div class="form-group">
        <label class="form-label" id="remarkLabel">备注说明</label>
        <textarea id="remarkInput" rows="3" placeholder="请填写情况说明（如选择无法出工则必填原因）"></textarea>
      </div>

      <button type="button" id="submitBtn" class="btn-submit" onclick="submitFeedback()">立即提交反馈</button>
    </div>
  </div>

  <script>
    const orderNo = "${orderNo}";
    const feedbackType = "${type}";
    let willAttend = true;
    let uploadedScreenshotUrl = "";
    let orderInfo = null;

    async function init() {
      if (feedbackType === 'same_day') {
        document.getElementById('pageTitle').innerText = '当天防迟到出工确认';
        document.getElementById('pageSubtitle').innerText = '请确认您今日已出发/已就位，防范迟到风险';
        document.getElementById('screenshotGroup').style.display = 'none';
      } else {
        document.getElementById('pageTitle').innerText = '前一天出工确认';
        document.getElementById('pageSubtitle').innerText = '请提前确认明日出工安排并上传联系客户凭证';
      }

      try {
        const res = await fetch('/api/v1/escort-feedback/info?orderNo=' + encodeURIComponent(orderNo) + '&type=' + feedbackType);
        const json = await res.json();
        document.getElementById('loading').style.display = 'none';
        document.getElementById('content').style.display = 'block';

        if (json.data) {
          orderInfo = json.data;
          document.getElementById('dispOrderNo').innerText = orderInfo.orderNo || '-';
          document.getElementById('dispCustomer').innerText = orderInfo.customerName || '-';
          document.getElementById('dispHospital').innerText = orderInfo.hospital + (orderInfo.dept ? ' · ' + orderInfo.dept : '');
          document.getElementById('dispServiceDate').innerText = orderInfo.serviceDate || '以约定时间为准';
          document.getElementById('dispPzr').innerText = orderInfo.pzr || '未指定';

          if (orderInfo.existingFeedback) {
            const fb = orderInfo.existingFeedback;
            document.getElementById('submittedCard').style.display = 'block';
            document.getElementById('submittedDesc').innerText = '您已于 ' + new Date(fb.createdAt).toLocaleString() + ' 反馈【' + (fb.willAttend ? '确认出工' : '无法出工') + '】' + (fb.remark ? '：' + fb.remark : '') + '，无需重复提交。';
            document.getElementById('formCard').style.display = 'none';
          }
        }
      } catch (err) {
        document.getElementById('loading').innerText = '加载失败，请检查网络或刷新重试';
      }
    }

    function setAttend(attend) {
      willAttend = attend;
      const yesBtn = document.getElementById('btnAttendYes');
      const noBtn = document.getElementById('btnAttendNo');
      const remarkLabel = document.getElementById('remarkLabel');

      if (attend) {
        yesBtn.className = 'radio-card active-yes';
        noBtn.className = 'radio-card';
        remarkLabel.innerHTML = '备注说明 (选填)';
      } else {
        yesBtn.className = 'radio-card';
        noBtn.className = 'radio-card active-no';
        remarkLabel.innerHTML = '无法出工原因 <span class="required">*</span>';
      }
    }

    function handleFileSelect(event) {
      const file = event.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (e) => {
        const base64 = e.target.result;
        document.getElementById('previewImg').src = base64;
        document.getElementById('previewWrap').style.display = 'inline-block';
        document.getElementById('uploadPrompt').style.display = 'none';

        try {
          const upRes = await fetch('/api/v1/escort-feedback/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: base64, fileName: file.name })
          });
          const upJson = await upRes.json();
          if (upJson.data && upJson.data.url) {
            uploadedScreenshotUrl = upJson.data.url;
          } else {
            uploadedScreenshotUrl = base64;
          }
        } catch {
          uploadedScreenshotUrl = base64;
        }
      };
      reader.readAsDataURL(file);
    }

    function removeImage(event) {
      event.stopPropagation();
      event.preventDefault();
      document.getElementById('fileInput').value = '';
      document.getElementById('previewWrap').style.display = 'none';
      document.getElementById('uploadPrompt').style.display = 'block';
      uploadedScreenshotUrl = '';
    }

    async function submitFeedback() {
      const remark = document.getElementById('remarkInput').value.trim();

      if (!willAttend && !remark) {
        alert('请填写无法出工的具体原因！');
        return;
      }

      if (feedbackType === 'pre_day' && willAttend && !uploadedScreenshotUrl) {
        if (!confirm('尚未上传联系客户截图，确定直接提交吗？（建议上传沟通截图以便留存凭据）')) {
          return;
        }
      }

      const btn = document.getElementById('submitBtn');
      btn.disabled = true;
      btn.innerText = '正在提交...';

      try {
        const res = await fetch('/api/v1/escort-feedback/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderNo: orderNo || orderInfo?.orderNo,
            pzrId: orderInfo?.pzrId,
            pzrName: orderInfo?.pzrName,
            pzr: orderInfo?.pzr,
            feedbackType: feedbackType,
            willAttend: willAttend,
            screenshotUrl: uploadedScreenshotUrl,
            remark: remark
          })
        });
        const json = await res.json();
        if (json.data && json.data.success) {
          document.getElementById('formCard').style.display = 'none';
          document.getElementById('submittedCard').style.display = 'block';
          document.getElementById('submittedDesc').innerText = '感谢您的配合，本次出工反馈已成功同步至客户经理！';
        } else {
          alert('提交失败：' + (json.error || '未知错误'));
          btn.disabled = false;
          btn.innerText = '立即提交反馈';
        }
      } catch (err) {
        alert('提交出错，请稍后重试');
        btn.disabled = false;
        btn.innerText = '立即提交反馈';
      }
    }

    window.onload = init;
  </script>
</body>
</html>`

      reply.type('text/html').send(html)
    }
  )
}
