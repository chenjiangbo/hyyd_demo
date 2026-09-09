import React, { useState } from 'react'

// ─── 1. 标准操作提示对话框 Modal ───
export interface AlertModalConfig {
  isOpen: boolean
  title: string
  message: string
  type: 'warning' | 'error' | 'success' | 'info'
  confirmText?: string
  onClose?: () => void
}

export const StandardAlertModal: React.FC<AlertModalConfig> = ({
  isOpen,
  title,
  message,
  type,
  confirmText = '我知道了',
  onClose
}) => {
  if (!isOpen) return null

  const defaultTitle =
    title ||
    (type === 'error'
      ? '错误提示'
      : type === 'warning'
        ? '操作警告'
        : type === 'success'
          ? '操作成功'
          : '系统提示')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="bg-white rounded-2xl shadow-2xl border border-border-subtle max-w-md w-full overflow-hidden animate-in zoom-in-95 duration-150">
        <div className="p-6 space-y-4">
          <div className="flex items-start gap-3.5">
            <div
              className={
                'w-11 h-11 rounded-xl flex items-center justify-center shrink-0 border ' +
                (type === 'error'
                  ? 'bg-red-50 text-error border-red-200'
                  : type === 'warning'
                    ? 'bg-amber-50 text-amber-600 border-amber-200'
                    : type === 'success'
                      ? 'bg-emerald-50 text-action-green border-emerald-200'
                      : 'bg-primary/10 text-primary border-primary/20')
              }
            >
              <span className="material-symbols-outlined text-[26px]">
                {type === 'error'
                  ? 'error'
                  : type === 'warning'
                    ? 'warning'
                    : type === 'success'
                      ? 'check_circle'
                      : 'info'}
              </span>
            </div>
            <div className="space-y-1.5 flex-1 min-w-0">
              <h3 className="text-h3-title text-text-main font-bold">{defaultTitle}</h3>
              <p className="text-body-sm text-text-muted leading-relaxed whitespace-pre-wrap break-words">
                {message}
              </p>
            </div>
          </div>
        </div>
        <div className="px-6 py-4 bg-surface-container-low/50 border-t border-border-subtle flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-lg bg-primary text-white text-body-sm font-semibold hover:bg-primary/90 transition-colors shadow-xs cursor-pointer"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── 2. 标准二次确认通用对话框 Modal ───
export interface ConfirmModalConfig {
  isOpen: boolean
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  type?: 'primary' | 'danger'
  onConfirm: () => void
  onCancel?: () => void
}

export const StandardConfirmModal: React.FC<ConfirmModalConfig> = ({
  isOpen,
  title,
  message,
  confirmText = '确定',
  cancelText = '取消',
  type = 'primary',
  onConfirm,
  onCancel
}) => {
  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="bg-white rounded-2xl shadow-2xl border border-border-subtle max-w-md w-full overflow-hidden animate-in zoom-in-95 duration-150">
        <div className="p-6 space-y-4">
          <div className="flex items-start gap-3.5">
            <div
              className={
                'w-10 h-10 rounded-full flex items-center justify-center shrink-0 ' +
                (type === 'danger' ? 'bg-red-50 text-error' : 'bg-primary/10 text-primary')
              }
            >
              <span className="material-symbols-outlined text-[24px]">
                {type === 'danger' ? 'warning' : 'help'}
              </span>
            </div>
            <div className="space-y-1 flex-1 min-w-0">
              <h3 className="text-h3-title text-text-main font-bold">{title}</h3>
              <p className="text-body-sm text-text-muted leading-relaxed whitespace-pre-wrap break-words">
                {message}
              </p>
            </div>
          </div>
        </div>

        <div className="px-6 py-4 bg-surface-container-low/50 border-t border-border-subtle flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-body-sm font-medium text-text-muted hover:text-text-main hover:bg-surface-container-low transition-colors cursor-pointer"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={
              'px-4 py-2 rounded-lg text-body-sm font-semibold text-white shadow-xs transition-colors cursor-pointer ' +
              (type === 'danger'
                ? 'bg-error hover:bg-red-600'
                : 'bg-primary hover:bg-primary/90')
            }
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── 3. 标准状态选择胶囊下拉组件 ───
export interface StandardStateSelectProps {
  value: string
  onChange: (val: string) => void
  disabled?: boolean
  className?: string
}

export const StandardStateSelect: React.FC<StandardStateSelectProps> = ({
  value,
  onChange,
  disabled = false,
  className = ''
}) => {
  const isEnabled = value === '启用' || value === 'enabled'

  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={
        'px-3 py-1.5 border rounded-md text-body-sm font-medium focus:outline-none transition-all cursor-pointer whitespace-nowrap shadow-2xs ' +
        (isEnabled
          ? 'border-emerald-200 text-action-green bg-emerald-50/60 hover:border-action-green'
          : 'border-border-subtle text-text-muted bg-surface-container-low hover:border-outline') +
        ' ' +
        className
      }
    >
      <option value="启用">● 启用</option>
      <option value="停用">○ 停用</option>
    </select>
  )
}

// ─── 4. 标准单行下钻操作按钮组件 ───
export interface StandardSubTableBtnProps {
  label: string
  onClick: () => void
  title?: string
  className?: string
}

export const StandardSubTableBtn: React.FC<StandardSubTableBtnProps> = ({
  label,
  onClick,
  title,
  className = ''
}) => {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title || `点击查看并配置${label}`}
      className={
        'inline-flex items-center gap-0.5 px-2.5 py-1 rounded-md text-primary bg-primary/10 hover:bg-primary hover:text-white border border-primary/20 text-[13px] font-medium transition-all cursor-pointer group shadow-2xs whitespace-nowrap ' +
        className
      }
    >
      <span>{label}</span>
      <span className="material-symbols-outlined text-[15px] transition-transform group-hover:translate-x-0.5">
        chevron_right
      </span>
    </button>
  )
}

// ─── 5. 标准纯白底完整数字分页栏组件 ───
export interface StandardPaginationBarProps {
  totalCount: number
  currentPage: number
  pageSize: number
  onPageChange: (page: number) => void
  onPageSizeChange: (size: number) => void
  pageSizeOptions?: number[]
}

export const StandardPaginationBar: React.FC<StandardPaginationBarProps> = ({
  totalCount,
  currentPage,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50, 100]
}) => {
  const [jumpPage, setJumpPage] = useState<string>('')
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages)

  const startIdx = totalCount === 0 ? 0 : (safeCurrentPage - 1) * pageSize + 1
  const endIdx = Math.min(safeCurrentPage * pageSize, totalCount)

  const handleJump = (): void => {
    const target = parseInt(jumpPage, 10)
    if (!isNaN(target) && target >= 1 && target <= totalPages) {
      onPageChange(target)
      setJumpPage('')
    }
  }

  return (
    <div className="px-5 py-3.5 bg-white border-t border-border-subtle flex flex-wrap items-center justify-between gap-4 text-body-sm text-text-muted shrink-0 select-none">
      {/* 左侧区间统计信息 */}
      <div className="flex items-center gap-3">
        <span>
          共 <strong className="text-text-main font-semibold">{totalCount}</strong> 条
        </span>
        <span className="text-outline">|</span>
        <span>
          第 <strong className="text-text-main font-semibold">{startIdx}</strong> -{' '}
          <strong className="text-text-main font-semibold">{endIdx}</strong> 条
        </span>
      </div>

      {/* 右侧分页操作组 */}
      <div className="flex items-center flex-wrap gap-3">
        {/* 每页条数下拉选择 */}
        <div className="flex items-center gap-1.5">
          <select
            value={pageSize}
            onChange={(e) => {
              onPageSizeChange(Number(e.target.value))
              onPageChange(1)
            }}
            className="px-2.5 py-1.5 bg-white border border-border-subtle rounded-lg text-body-sm text-text-main hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer transition-all"
          >
            {pageSizeOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt} 条/页
              </option>
            ))}
          </select>
        </div>

        {/* 翻页按钮组 */}
        <div className="flex items-center gap-1">
          {/* 首页 */}
          <button
            type="button"
            disabled={safeCurrentPage <= 1}
            onClick={() => onPageChange(1)}
            className="p-1.5 rounded-lg border border-border-subtle bg-white hover:bg-surface-container-low text-text-main disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center justify-center"
            title="第一页"
          >
            <span className="material-symbols-outlined text-[18px]">first_page</span>
          </button>

          {/* 上一页 */}
          <button
            type="button"
            disabled={safeCurrentPage <= 1}
            onClick={() => onPageChange(Math.max(1, safeCurrentPage - 1))}
            className="p-1.5 rounded-lg border border-border-subtle bg-white hover:bg-surface-container-low text-text-main disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center justify-center"
            title="上一页"
          >
            <span className="material-symbols-outlined text-[18px]">chevron_left</span>
          </button>

          {/* 动态数字页码组 */}
          <div className="flex items-center gap-1 mx-1">
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((p) => {
                if (totalPages <= 7) return true
                if (p === 1 || p === totalPages) return true
                return Math.abs(p - safeCurrentPage) <= 1
              })
              .reduce<(number | string)[]>((acc, p, index, arr) => {
                if (index > 0 && typeof p === 'number' && typeof arr[index - 1] === 'number') {
                  if (p - (arr[index - 1] as number) > 1) {
                    acc.push('...')
                  }
                }
                acc.push(p)
                return acc
              }, [])
              .map((pageItem, pIdx) => {
                if (pageItem === '...') {
                  return (
                    <span key={`ellipsis-${pIdx}`} className="px-1.5 text-text-muted select-none">
                      ...
                    </span>
                  )
                }
                const pNum = Number(pageItem)
                const isCurrent = pNum === safeCurrentPage
                return (
                  <button
                    key={`page-${pNum}`}
                    type="button"
                    onClick={() => onPageChange(pNum)}
                    className={
                      'min-w-[32px] h-8 px-2 rounded-lg text-body-sm font-medium transition-all cursor-pointer flex items-center justify-center ' +
                      (isCurrent
                        ? 'bg-primary text-white font-semibold shadow-xs'
                        : 'border border-border-subtle bg-white hover:bg-surface-container-low text-text-main')
                    }
                  >
                    {pNum}
                  </button>
                )
              })}
          </div>

          {/* 下一页 */}
          <button
            type="button"
            disabled={safeCurrentPage >= totalPages}
            onClick={() => onPageChange(Math.min(totalPages, safeCurrentPage + 1))}
            className="p-1.5 rounded-lg border border-border-subtle bg-white hover:bg-surface-container-low text-text-main disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center justify-center"
            title="下一页"
          >
            <span className="material-symbols-outlined text-[18px]">chevron_right</span>
          </button>

          {/* 末页 */}
          <button
            type="button"
            disabled={safeCurrentPage >= totalPages}
            onClick={() => onPageChange(totalPages)}
            className="p-1.5 rounded-lg border border-border-subtle bg-white hover:bg-surface-container-low text-text-main disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center justify-center"
            title="最后一页"
          >
            <span className="material-symbols-outlined text-[18px]">last_page</span>
          </button>
        </div>

        {/* 精确跳页输入与跳转按钮 */}
        <div className="flex items-center gap-1.5 text-body-sm">
          <span>前往</span>
          <input
            type="number"
            min={1}
            max={totalPages}
            value={jumpPage}
            onChange={(e) => setJumpPage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleJump()
            }}
            placeholder={String(safeCurrentPage)}
            className="w-14 px-2 py-1 bg-white border border-border-subtle rounded-lg text-center text-body-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          />
          <span>页</span>
          <button
            type="button"
            onClick={handleJump}
            className="px-2.5 py-1 rounded-lg border border-border-subtle bg-white hover:bg-surface-container-low text-text-main text-body-sm font-medium transition-colors cursor-pointer"
          >
            跳转
          </button>
        </div>
      </div>
    </div>
  )
}
