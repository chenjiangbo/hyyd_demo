import { useState, useEffect } from 'react'
import {
  adminApi,
  type SmsConfig,
  type SmsLogItem,
  type TestSmsResult
} from '../api/client'
import { Card, PageHeader, LoadingBlock, ErrorBlock } from '../components/ui'

export default function SmsConfigPage(): React.JSX.Element {
  const [, setConfig] = useState<SmsConfig | null>(null)
  const [isConfigured, setIsConfigured] = useState<boolean>(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  // 表单编辑字段
  const [enabled, setEnabled] = useState(true)
  const [accessKeyId, setAccessKeyId] = useState('')
  const [accessKeySecret, setAccessKeySecret] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [signName, setSignName] = useState('寰宇医道')
  const [templatePreDay, setTemplatePreDay] = useState('SMS_512665048')
  const [templateSameDay, setTemplateSameDay] = useState('SMS_512530051')

  // 保存状态
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  // 测试发信工具
  const [testPhone, setTestPhone] = useState('')
  const [testOrderNo, setTestOrderNo] = useState('TEST2026092201')
  const [testBatchType, setTestBatchType] = useState<'pre_day' | 'same_day'>('pre_day')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestSmsResult | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  // 短信流水日志
  const [logs, setLogs] = useState<SmsLogItem[]>([])
  const [loadingLogs, setLoadingLogs] = useState(false)

  async function loadConfig(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const res = await adminApi.smsConfig()
      setConfig(res.config)
      setIsConfigured(res.isConfigured)
      setEnabled(res.config.enabled)
      setAccessKeyId(res.config.accessKeyId || '')
      setAccessKeySecret(res.config.accessKeySecret || '')
      setSignName(res.config.signName || '寰宇医道')
      setTemplatePreDay(res.config.templatePreDay || 'SMS_512665048')
      setTemplateSameDay(res.config.templateSameDay || 'SMS_512530051')
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setLoading(false)
    }
  }

  async function loadLogs(): Promise<void> {
    setLoadingLogs(true)
    try {
      const data = await adminApi.smsLogs(30)
      setLogs(data)
    } catch {
      // 忽略日志加载异常
    } finally {
      setLoadingLogs(false)
    }
  }

  useEffect(() => {
    void loadConfig()
    void loadLogs()
  }, [])

  async function handleSave(): Promise<void> {
    setSaving(true)
    setSaveMsg(null)
    try {
      const res = await adminApi.saveSmsConfig({
        enabled,
        accessKeyId: accessKeyId.trim(),
        accessKeySecret: accessKeySecret.trim(),
        signName: signName.trim() || '寰宇医道',
        templatePreDay: templatePreDay.trim() || 'SMS_512665048',
        templateSameDay: templateSameDay.trim() || 'SMS_512530051'
      })
      setConfig(res.data.config)
      setIsConfigured(res.data.isConfigured)
      setSaveMsg({ type: 'ok', text: res.message || '短信模板配置已保存并立即生效' })
      setTimeout(() => setSaveMsg(null), 4000)
    } catch (err: any) {
      setSaveMsg({ type: 'error', text: err?.message || '保存失败，请重试' })
    } finally {
      setSaving(false)
    }
  }

  async function handleSendTest(): Promise<void> {
    const phone = testPhone.trim()
    if (!phone) {
      setTestError('请输入测试手机号码')
      return
    }
    if (!/^1\d{10}$/.test(phone)) {
      setTestError('手机号码格式不合法（应为 11 位数字）')
      return
    }

    setTesting(true)
    setTestError(null)
    setTestResult(null)

    try {
      const res = await adminApi.testSendSms({
        phone,
        orderNo: testOrderNo.trim() || 'TEST2026092201',
        batchType: testBatchType
      })
      setTestResult(res)
      // 自动刷新流水
      void loadLogs()
    } catch (err: any) {
      setTestError(err?.message || '测试发信请求失败')
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return <LoadingBlock label="加载短信模板配置中..." />
  }

  if (error) {
    return <ErrorBlock error={error} onRetry={() => void loadConfig()} />
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <PageHeader title="短信模板配置" />
          <p className="text-xs text-fg-muted mt-1">
            配置阿里云短信服务（Dysmsapi）接口密钥、陪诊前一日/当天触发模板，提供连通性在线测试与发送流水日志。
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors flex items-center gap-2 shadow-sm cursor-pointer"
          >
            {saving ? (
              <>
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                正在保存...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                </svg>
                保存配置并立即生效
              </>
            )}
          </button>
        </div>
      </div>

      {/* 提示与状态条 */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3.5 rounded-xl border border-line bg-surface-2 text-xs">
        <div className="flex items-center gap-2 text-fg-default">
          <span className="text-base">💡</span>
          <span>
            配置修改后写入系统设置并<b>在后端内存中实时热刷新</b>，定时任务下一次轮询直接生效，无需重启服务。
          </span>
        </div>
        <div>
          {isConfigured ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              API 密钥已配置
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              未配置 AccessKey（请填写并保存）
            </span>
          )}
        </div>
      </div>

      {saveMsg && (
        <div
          className={`p-3 rounded-lg text-xs font-medium ${
            saveMsg.type === 'ok'
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-500/20'
              : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300 border border-red-500/20'
          }`}
        >
          {saveMsg.text}
        </div>
      )}

      {/* 主布局：两列 */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* 左侧：凭证与模板配置 */}
        <div className="lg:col-span-7 space-y-6">
          {/* 卡片 1: 阿里云 API 凭证 */}
          <Card className="p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-fg-default">🔑 阿里云短信 API 凭证</span>
                <span className="text-[11px] text-fg-muted bg-surface-3 px-2 py-0.5 rounded">POP RPC 协议</span>
              </div>
              <span className="text-xs text-fg-muted">用于调用阿里云短信接口</span>
            </div>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="block text-xs font-medium text-fg-default">
                  AccessKey ID <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  placeholder="例如: LTAI5txxxxxxxxxxxxxxxx"
                  value={accessKeyId}
                  onChange={(e) => setAccessKeyId(e.target.value)}
                  className="w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-sm text-fg-default placeholder:text-fg-subtle font-mono focus:outline-none focus:border-accent"
                />
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-medium text-fg-default">
                    AccessKey Secret <span className="text-danger">*</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowSecret(!showSecret)}
                    className="text-[11px] text-accent hover:underline cursor-pointer"
                  >
                    {showSecret ? '隐藏明文' : '显示明文'}
                  </button>
                </div>
                <div className="relative">
                  <input
                    type={showSecret ? 'text' : 'password'}
                    placeholder="请输入阿里云 AccessKey Secret"
                    value={accessKeySecret}
                    onChange={(e) => setAccessKeySecret(e.target.value)}
                    className="w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-sm text-fg-default placeholder:text-fg-subtle font-mono focus:outline-none focus:border-accent pr-10"
                  />
                  <span className="absolute right-3 top-2.5 text-fg-muted pointer-events-none">🔒</span>
                </div>
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-medium text-fg-default">
                  短信签名 (SignName) <span className="text-danger">*</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="例如: 寰宇医道"
                    value={signName}
                    onChange={(e) => setSignName(e.target.value)}
                    className="w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-sm text-fg-default placeholder:text-fg-subtle focus:outline-none focus:border-accent"
                  />
                  <span className="shrink-0 text-xs text-fg-muted px-3 py-2 bg-surface-3 rounded-lg border border-line">
                    【{signName || '签名'}】
                  </span>
                </div>
                <p className="text-[11px] text-fg-muted">必须与阿里云短信控制台中审核通过的签名完全一致（无需包含括号【】）。</p>
              </div>
            </div>
          </Card>

          {/* 卡片 2: 模板配置 */}
          <Card className="p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold text-fg-default">📋 陪诊通知模板配置</span>
              </div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <span className="text-xs text-fg-muted">短信自动发送开关</span>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="rounded border-line text-accent focus:ring-accent w-4 h-4 cursor-pointer"
                />
              </label>
            </div>

            <div className="space-y-4">
              {/* 前一日通知 */}
              <div className="p-3.5 rounded-lg border border-line bg-surface-2 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                      前一天通知
                    </span>
                    <span className="text-xs font-medium text-fg-default">陪诊人员次日行程提醒与核对</span>
                  </div>
                  <span className="text-xs text-accent font-mono">每日 11:00 发送</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[11px] text-fg-muted font-medium">阿里云模板代码 (TemplateCode)</label>
                    <input
                      type="text"
                      value={templatePreDay}
                      onChange={(e) => setTemplatePreDay(e.target.value)}
                      className="w-full bg-surface-3 border border-line rounded px-2.5 py-1.5 text-xs text-fg-default font-mono focus:outline-none focus:border-accent"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-fg-muted font-medium">绑定模板参数</label>
                    <input
                      type="text"
                      readOnly
                      value="${orderNo}"
                      className="w-full bg-surface-3/50 border border-line rounded px-2.5 py-1.5 text-xs text-fg-muted font-mono cursor-not-allowed"
                    />
                  </div>
                </div>

                <div className="text-[11px] text-fg-muted flex items-center gap-1.5">
                  <span>⏱ 检查未反馈门禁：</span>
                  <span>仅在短信发送成功时，13:00 扫描未收到陪诊初次反馈才触发未反馈提醒；短信发送失败则 11:00 立即告警。</span>
                </div>
              </div>

              {/* 当日通知 */}
              <div className="p-3.5 rounded-lg border border-line bg-surface-2 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                      当日通知
                    </span>
                    <span className="text-xs font-medium text-fg-default">陪诊人员出发与按时签到反馈</span>
                  </div>
                  <span className="text-xs text-accent font-mono">当日 07:00 发送</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[11px] text-fg-muted font-medium">阿里云模板代码 (TemplateCode)</label>
                    <input
                      type="text"
                      value={templateSameDay}
                      onChange={(e) => setTemplateSameDay(e.target.value)}
                      className="w-full bg-surface-3 border border-line rounded px-2.5 py-1.5 text-xs text-fg-default font-mono focus:outline-none focus:border-accent"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-fg-muted font-medium">绑定模板参数</label>
                    <input
                      type="text"
                      readOnly
                      value="${orderNo}"
                      className="w-full bg-surface-3/50 border border-line rounded px-2.5 py-1.5 text-xs text-fg-muted font-mono cursor-not-allowed"
                    />
                  </div>
                </div>

                <div className="text-[11px] text-fg-muted flex items-center gap-1.5">
                  <span>⏱ 检查未反馈门禁：</span>
                  <span>仅在短信发送成功时，07:20 扫描未收到反馈才触发未反馈提醒；短信发送失败则 07:00 立即告警。</span>
                </div>
              </div>
            </div>
          </Card>
        </div>

        {/* 右侧：实时在线测试与规则说明 */}
        <div className="lg:col-span-5 space-y-6">
          {/* 卡片 3: 在线连通性测试 */}
          <Card className="p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-line pb-3">
              <span className="text-base font-semibold text-fg-default flex items-center gap-2">
                <span>⚡ 在线连通性测试</span>
              </span>
              <span className="text-[11px] text-fg-muted">即时验证 Key 与模板</span>
            </div>

            <p className="text-xs text-fg-muted">
              输入接收测试短信的手机号，点击发送按钮即可直接调用阿里云接口，秒级验证配置是否生效。
            </p>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs text-fg-default font-medium">测试手机号</label>
                <input
                  type="text"
                  placeholder="例如: 13800000000"
                  value={testPhone}
                  onChange={(e) => setTestPhone(e.target.value)}
                  className="w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-xs text-fg-default font-mono focus:outline-none focus:border-accent"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs text-fg-default font-medium">模拟订单号 (${'{orderNo}'})</label>
                <input
                  type="text"
                  placeholder="例如: TEST2026092201"
                  value={testOrderNo}
                  onChange={(e) => setTestOrderNo(e.target.value)}
                  className="w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-xs text-fg-default font-mono focus:outline-none focus:border-accent"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs text-fg-default font-medium">选择要测试的模板</label>
                <select
                  value={testBatchType}
                  onChange={(e) => setTestBatchType(e.target.value as any)}
                  className="w-full bg-surface-2 border border-line rounded-lg px-3 py-2 text-xs text-fg-default focus:outline-none focus:border-accent cursor-pointer"
                >
                  <option value="pre_day">前一日通知 ({templatePreDay || 'SMS_512665048'})</option>
                  <option value="same_day">当日通知 ({templateSameDay || 'SMS_512530051'})</option>
                </select>
              </div>

              <button
                type="button"
                onClick={handleSendTest}
                disabled={testing}
                className="w-full py-2.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow disabled:opacity-50 transition-colors flex items-center justify-center gap-2 mt-2 cursor-pointer"
              >
                {testing ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    正在调用阿里云 API 发送...
                  </>
                ) : (
                  <>🚀 立即发送测试短信</>
                )}
              </button>

              {testError && (
                <div className="p-3 rounded-lg border border-red-500/20 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300 text-xs">
                  {testError}
                </div>
              )}

              {testResult && (
                <div
                  className={`p-3 rounded-lg border text-xs ${
                    testResult.success
                      ? 'border-emerald-500/30 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
                      : 'border-red-500/30 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200'
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold mb-1">
                    <span>{testResult.success ? '✓ 阿里云接口调用成功' : '✗ 阿里云接口调用失败'}</span>
                    <span className="font-mono text-[10px] opacity-75">{new Date().toLocaleTimeString()}</span>
                  </div>
                  <pre className="font-mono text-[11px] overflow-x-auto p-2 rounded bg-black/10 dark:bg-black/30 whitespace-pre-wrap break-all mt-1">
                    {JSON.stringify(testResult, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </Card>

          {/* 卡片 4: 业务防护与防误报机制 */}
          <Card className="p-5 text-xs space-y-2.5 bg-surface-2/60">
            <h3 className="font-semibold text-fg-default">🛡 业务防护与防误报机制说明</h3>
            <ul className="space-y-1.5 list-disc list-inside text-fg-muted leading-relaxed">
              <li>
                <b className="text-fg-default">服务矩阵隔离</b>：仅限包含陪诊的服务订单，住院护工协助、挂号协助、接送等服务绝不发短信，杜绝陪诊误报。
              </li>
              <li>
                <b className="text-fg-default">失败即时报警</b>：若陪诊人员无手机号或短信发送失败，调度器在 11:00 或 07:00 立即向客户经理报警，便于人工电话介入。
              </li>
              <li>
                <b className="text-fg-default">未反馈前置门禁</b>：只有短信发送成功，系统才会在 13:00 / 07:20 检测未反馈；短信没发成绝不误报“未反馈”。
              </li>
              <li>
                <b className="text-fg-default">每日幂等</b>：同一订单、同一批次、同一天内仅发送一次，绝不重复打扰。
              </li>
            </ul>
          </Card>
        </div>
      </div>

      {/* 底部卡片：最近短信发送流水 */}
      <Card className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-fg-default">📊 最近短信发送流水 (fact_hy_pz_sms_logs)</span>
            <span className="text-xs text-fg-muted">最新 {logs.length} 条记录</span>
          </div>
          <button
            type="button"
            onClick={() => void loadLogs()}
            disabled={loadingLogs}
            className="text-xs text-accent hover:underline cursor-pointer flex items-center gap-1"
          >
            {loadingLogs ? '刷新中...' : '⟳ 刷新日志'}
          </button>
        </div>

        {logs.length === 0 ? (
          <div className="py-8 text-center text-xs text-fg-muted">
            {loadingLogs ? '正在加载日志...' : '暂无短信发送记录'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-line text-fg-muted bg-surface-2/50">
                  <th className="py-2.5 px-3">发送时间</th>
                  <th className="py-2.5 px-3">订单号</th>
                  <th className="py-2.5 px-3">批次类型</th>
                  <th className="py-2.5 px-3">陪诊人员</th>
                  <th className="py-2.5 px-3">接收手机</th>
                  <th className="py-2.5 px-3">模板代码</th>
                  <th className="py-2.5 px-3">状态</th>
                  <th className="py-2.5 px-3">回执 / 响应信息</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line font-mono text-[11px]">
                {logs.map((row) => (
                  <tr key={row.id} className="hover:bg-surface-2/40">
                    <td className="py-2.5 px-3 text-fg-muted whitespace-nowrap">
                      {row.created_at ? new Date(row.created_at).toLocaleString('zh-CN', { hour12: false }) : '-'}
                    </td>
                    <td className="py-2.5 px-3 text-accent font-medium">{row.order_no}</td>
                    <td className="py-2.5 px-3">
                      {row.batch_type === 'pre_day' ? (
                        <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300 font-sans">
                          前一日通知
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 font-sans">
                          当日通知
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-fg-default font-sans">{row.pzr_name || '-'}</td>
                    <td className="py-2.5 px-3 text-fg-default">{row.phone || <span className="text-danger font-sans">无手机号</span>}</td>
                    <td className="py-2.5 px-3 text-fg-muted">{row.template_code}</td>
                    <td className="py-2.5 px-3 font-sans">
                      {row.status === 'success' ? (
                        <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 font-medium">
                          发送成功
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300 font-medium">
                          发送失败
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 text-fg-muted truncate max-w-xs font-sans" title={row.error_message || row.biz_id || ''}>
                      {row.status === 'success' ? (
                        <span className="text-emerald-600 dark:text-emerald-400 font-mono">BizId: {row.biz_id}</span>
                      ) : (
                        <span className="text-danger">{row.error_message || row.error_code}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
