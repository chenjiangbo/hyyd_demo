import React, { useState } from 'react'
import { changePassword } from '../api'

interface ChangePasswordModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccessLogout: () => void
}

export default function ChangePasswordModal({
  isOpen,
  onClose,
  onSuccessLogout
}: ChangePasswordModalProps): React.JSX.Element | null {
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showOldPwd, setShowOldPwd] = useState(false)
  const [showNewPwd, setShowNewPwd] = useState(false)
  const [showConfirmPwd, setShowConfirmPwd] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  if (!isOpen) return null

  function resetForm(): void {
    setOldPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setError(null)
    setSuccess(false)
  }

  function handleClose(): void {
    resetForm()
    onClose()
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    setError(null)

    const oldPwd = oldPassword.trim()
    const newPwd = newPassword.trim()
    const confirmPwd = confirmPassword.trim()

    if (!oldPwd) {
      setError('请输入旧密码')
      return
    }
    if (!newPwd) {
      setError('请输入新密码')
      return
    }
    if (newPwd.length < 4) {
      setError('新密码长度不能少于4位')
      return
    }
    if (!confirmPwd) {
      setError('请再次输入新密码进行确认')
      return
    }
    if (newPwd !== confirmPwd) {
      setError('两次输入的新密码不一致，请重新核对')
      return
    }
    if (newPwd === oldPwd) {
      setError('新密码不能与旧密码相同')
      return
    }

    setLoading(true)
    try {
      await changePassword(oldPwd, newPwd)
      setSuccess(true)
      setTimeout(() => {
        handleClose()
        onSuccessLogout()
      }, 1000)
    } catch (err: any) {
      setError(err?.message || '密码修改失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-white rounded-xl shadow-2xl border border-border-subtle overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle bg-surface-container-low">
          <div className="flex items-center space-x-2">
            <span className="material-symbols-outlined text-primary text-xl">lock_reset</span>
            <h3 className="text-title-sm font-bold text-text-main">修改密码</h3>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="text-outline hover:text-text-main p-1 rounded-md transition-colors"
          >
            <span className="material-symbols-outlined text-lg">close</span>
          </button>
        </div>

        {/* 表单内容 */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-body-sm flex items-start space-x-2">
              <span className="material-symbols-outlined text-red-500 text-base mt-0.5">error</span>
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-body-sm flex items-center space-x-2">
              <span className="material-symbols-outlined text-green-600 text-base">check_circle</span>
              <span>密码修改成功！正在退出，请使用新密码重新登录...</span>
            </div>
          )}

          {/* 旧密码 */}
          <div className="space-y-1.5">
            <label className="block text-body-sm font-medium text-text-main" htmlFor="oldPassword">
              旧密码：
            </label>
            <div className="relative">
              <input
                id="oldPassword"
                type={showOldPwd ? 'text' : 'password'}
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
                placeholder="请输入当前旧密码"
                disabled={loading || success}
                className="block w-full px-3 py-2 pr-10 border border-outline-variant rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-body-sm text-text-main transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowOldPwd(!showOldPwd)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-outline hover:text-text-main"
              >
                <span className="material-symbols-outlined text-base">
                  {showOldPwd ? 'visibility_off' : 'visibility'}
                </span>
              </button>
            </div>
          </div>

          {/* 新密码 */}
          <div className="space-y-1.5">
            <label className="block text-body-sm font-medium text-text-main" htmlFor="newPassword">
              新密码：
            </label>
            <div className="relative">
              <input
                id="newPassword"
                type={showNewPwd ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="请输入新密码"
                disabled={loading || success}
                className="block w-full px-3 py-2 pr-10 border border-outline-variant rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-body-sm text-text-main transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowNewPwd(!showNewPwd)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-outline hover:text-text-main"
              >
                <span className="material-symbols-outlined text-base">
                  {showNewPwd ? 'visibility_off' : 'visibility'}
                </span>
              </button>
            </div>
          </div>

          {/* 确认新密码 */}
          <div className="space-y-1.5">
            <label className="block text-body-sm font-medium text-text-main" htmlFor="confirmPassword">
              确认新密码：
            </label>
            <div className="relative">
              <input
                id="confirmPassword"
                type={showConfirmPwd ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="请再次输入新密码"
                disabled={loading || success}
                className="block w-full px-3 py-2 pr-10 border border-outline-variant rounded-lg bg-surface focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent text-body-sm text-text-main transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowConfirmPwd(!showConfirmPwd)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-outline hover:text-text-main"
              >
                <span className="material-symbols-outlined text-base">
                  {showConfirmPwd ? 'visibility_off' : 'visibility'}
                </span>
              </button>
            </div>
          </div>

          {/* 底部按钮 */}
          <div className="flex items-center justify-end space-x-3 pt-3 border-t border-border-subtle mt-6">
            <button
              type="button"
              onClick={handleClose}
              disabled={loading}
              className="px-4 py-2 border border-outline-variant rounded-lg text-body-sm text-text-muted hover:bg-surface-container-low transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={loading || success}
              className="px-5 py-2 bg-primary text-white rounded-lg text-body-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center space-x-1.5"
            >
              {loading && <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>}
              <span>{loading ? '正在保存...' : '确认修改'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
