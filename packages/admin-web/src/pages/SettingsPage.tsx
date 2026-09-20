import { useState, useEffect } from 'react'
import { useTheme, type ThemePreference } from '../lib/theme'
import { Card, PageHeader } from '../components/ui'
import { adminApi } from '../api/client'

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]

export default function SettingsPage(): React.JSX.Element {
  const { preference, setPreference } = useTheme()
  const [appInfo, setAppInfo] = useState<{
    exists: boolean
    fileName?: string
    sizeMb?: number
    updatedAt?: string
    downloadUrl?: string
    mobileDownloadUrl?: string
  } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)

  const loadAppInfo = async () => {
    try {
      const data = await adminApi.appInfo()
      setAppInfo(data)
    } catch {}
  }

  useEffect(() => {
    loadAppInfo()
  }, [])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const f = e.target.files[0]
      if (!f.name.toLowerCase().endsWith('.apk')) {
        setMsg({ type: 'error', text: '请选择 .apk 后缀的 Android 安装包文件' })
        setSelectedFile(null)
        return
      }
      setSelectedFile(f)
      setMsg(null)
    }
  }

  const handleUpload = async () => {
    if (!selectedFile) return
    setUploading(true)
    setMsg(null)
    try {
      const res = await adminApi.uploadApp(selectedFile)
      setMsg({ type: 'ok', text: res.message || '上传成功！' })
      setSelectedFile(null)
      loadAppInfo()
    } catch (e: any) {
      setMsg({ type: 'error', text: e?.message || '上传失败，请重试' })
    } finally {
      setUploading(false)
    }
  }

  const fileName = appInfo?.fileName || 'app-debug.apk'
  const pcDownloadUrl = appInfo?.downloadUrl || `/download/${encodeURIComponent(fileName)}`
  const mobileUrl = appInfo?.mobileDownloadUrl || `${window.location.protocol}//${window.location.host}${pcDownloadUrl}`

  const copyDownloadLink = () => {
    navigator.clipboard.writeText(mobileUrl)
    setMsg({ type: 'ok', text: `手机下载链接已复制：${mobileUrl}` })
  }

  return (
    <div className="space-y-6">
      <PageHeader title="系统设置" />

      {/* 移动端 App 安装包管理与下载 */}
      <Card className="p-5 max-w-2xl space-y-4">
        <div>
          <h2 className="text-base font-semibold text-fg-default">📱 移动端 App 安装包（发布与下载）</h2>
          <p className="text-xs text-fg-muted mt-1">
            管理员可在此选择打好的最新 Android 安装包 (.apk) 上传。系统将自动保持原文件名发布，手机直接访问或点击下方链接即可安装更新。
          </p>
        </div>

        {/* 当前线上包状态 */}
        <div className="rounded-lg border border-line bg-surface-2 p-4">
          <div className="text-xs font-medium text-fg-muted mb-2">当前线上安装包状态</div>
          {appInfo?.exists ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                <svg className="w-5 h-5 text-emerald-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>已就绪：{fileName} ({appInfo.sizeMb} MB)</span>
              </div>
              <div className="text-xs text-fg-muted">
                最新上传更新时间：{appInfo.updatedAt ? new Date(appInfo.updatedAt).toLocaleString() : '未知'}
              </div>
              <div className="text-xs text-fg-muted bg-surface-3 p-2.5 rounded border border-line break-all">
                <span className="font-semibold text-fg-default">手机下载链接：</span>
                <a href={mobileUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline ml-1 font-mono">
                  {mobileUrl}
                </a>
              </div>
              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={copyDownloadLink}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-white hover:bg-accent/90 transition-colors flex items-center gap-1.5"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                  </svg>
                  复制手机下载链接
                </button>
                <a
                  href={pcDownloadUrl}
                  download={fileName}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-1.5 rounded-md text-xs font-medium border border-line text-fg-default hover:bg-surface-3 transition-colors flex items-center gap-1.5"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  直接下载此包 ({fileName})
                </a>
              </div>
            </div>
          ) : (
            <div className="text-sm text-fg-muted flex items-center gap-2">
              <svg className="w-5 h-5 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              暂未上传安装包，请从下方选择 .apk 文件上传。
            </div>
          )}
        </div>

        {/* 上传新包 */}
        <div className="pt-2 border-t border-line space-y-3">
          <label className="block text-xs font-medium text-fg-default">上传最新 APK 文件（将自动保留原文件名，并替换旧包）</label>
          <div className="flex items-center gap-3">
            <input
              type="file"
              accept=".apk"
              onChange={handleFileChange}
              disabled={uploading}
              className="text-xs text-fg-muted file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-surface-3 file:text-fg-default hover:file:bg-surface-2 cursor-pointer"
            />
            {selectedFile && (
              <button
                type="button"
                onClick={handleUpload}
                disabled={uploading}
                className="px-4 py-1.5 rounded-md text-xs font-medium bg-accent text-white hover:bg-accent/90 disabled:opacity-50 transition-colors flex items-center gap-1.5"
              >
                {uploading ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    正在上传...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    上传此 APK 覆盖
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {msg && (
          <div
            className={`p-3 rounded-md text-xs font-medium ${
              msg.type === 'ok' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'
            }`}
          >
            {msg.text}
          </div>
        )}
      </Card>

      {/* 主题设置 */}
      <Card className="p-5 max-w-2xl">
        <h2 className="text-sm font-medium mb-3 text-fg-default">界面主题</h2>
        <div className="flex gap-2">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setPreference(opt.value)}
              className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                preference === opt.value
                  ? 'border-accent bg-accent-soft text-accent-strong font-medium'
                  : 'border-line text-fg-muted hover:bg-surface-2'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </Card>
    </div>
  )
}
