import React, { useState, useEffect, useCallback } from 'react'
import {
  PaymentChannelItem,
  HospitalItem,
  fetchPaymentChannels,
  savePaymentChannels,
  fetchHospitals,
  formatDisplayDate,
  getToday8
} from '../../api'
import {
  StandardAlertModal,
  StandardConfirmModal,
  StandardStateSelect,
  StandardPaginationBar,
  AlertModalConfig,
  ConfirmModalConfig
} from './dictComponents'

export default function PaymentChannelView(): React.JSX.Element {
  const [channelList, setChannelList] = useState<PaymentChannelItem[]>([])
  const [hospitals, setHospitals] = useState<HospitalItem[]>([])
  const [newlyAddedIds, setNewlyAddedIds] = useState<string[]>([])

  const [loading, setLoading] = useState<boolean>(true)
  const [saving, setSaving] = useState<boolean>(false)

  const [alertModal, setAlertModal] = useState<AlertModalConfig>({
    isOpen: false,
    title: '',
    message: '',
    type: 'info'
  })

  const [selectedIds, setSelectedIds] = useState<string[]>([])

  const [searchDraft, setSearchDraft] = useState('')
  const [searchStatusDraft, setSearchStatusDraft] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [appliedSearchQuery, setAppliedSearchQuery] = useState('')
  const [appliedSearchStatus, setAppliedSearchStatus] = useState<'all' | 'enabled' | 'disabled'>('all')

  const [page, setPage] = useState<number>(1)
  const [pageSize, setPageSize] = useState<number>(10)

  const [confirmModal, setConfirmModal] = useState<ConfirmModalConfig>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {}
  })

  const showAlert = (
    message: string,
    title?: string,
    type: 'warning' | 'error' | 'success' | 'info' = 'info',
    confirmText = '我知道了'
  ): void => {
    setAlertModal({
      isOpen: true,
      title: title || (type === 'error' ? '错误提示' : type === 'warning' ? '操作警告' : type === 'success' ? '操作成功' : '系统提示'),
      message,
      type,
      confirmText
    })
  }

  const closeAlertModal = (): void => {
    setAlertModal((prev) => ({ ...prev, isOpen: false }))
  }

  const closeConfirmModal = (): void => {
    setConfirmModal((prev) => ({ ...prev, isOpen: false }))
  }

  useEffect(() => {
    if (!alertModal.isOpen || alertModal.type !== 'success') return
    const timer = setTimeout(() => {
      closeAlertModal()
      if (alertModal.onClose) alertModal.onClose()
    }, 1000)
    return () => clearTimeout(timer)
  }, [alertModal.isOpen, alertModal.type, alertModal.onClose])

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [channelsData, hospData] = await Promise.all([
        fetchPaymentChannels(),
        fetchHospitals().catch(() => [])
      ])
      setChannelList(channelsData)
      setHospitals(hospData)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showAlert(`加载交付支出渠道失败：${message}`, '加载异常', 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const updateField = (id: string, field: keyof PaymentChannelItem, value: string): void => {
    setChannelList((prev) =>
      prev.map((item) => {
        if (item.id === id) {
          return { ...item, [field]: value }
        }
        return item
      })
    )
  }

  const handleAddNewChannel = (): void => {
    const existingIds = channelList
      .map((c) => parseInt(c.id, 10))
      .filter((n) => !isNaN(n))
    const maxId = existingIds.length > 0 ? Math.max(...existingIds) : 0
    const newId = String(maxId + 1).padStart(4, '0')

    const newChannel: PaymentChannelItem = {
      id: newId,
      name: `支出渠道_${newId}`,
      yy: hospitals.length > 0 ? hospitals[0].id : '0001',
      start: '启用',
      zf_id: `ZF_${newId}`,
      by1: '110000',
      by2: '110100',
      c_date: getToday8(),
      u_date: getToday8()
    }

    setChannelList((prev) => [newChannel, ...prev])
    setNewlyAddedIds((prev) => [...prev, newId])
    setPage(1)
  }

  const handleDeleteChannel = (id: string, name: string): void => {
    setConfirmModal({
      isOpen: true,
      title: '删除渠道确认',
      message: `确定要删除交付支出渠道【${name || id}】吗？`,
      type: 'danger',
      confirmText: '确认删除',
      cancelText: '取消',
      onConfirm: () => {
        setChannelList((prev) => prev.filter((c) => c.id !== id))
        setSelectedIds((prev) => prev.filter((sid) => sid !== id))
        closeConfirmModal()
      }
    })
  }

  const handleDeleteSelected = (): void => {
    if (selectedIds.length === 0) {
      showAlert('请先勾选需要删除的渠道', '操作提示', 'warning')
      return
    }

    setConfirmModal({
      isOpen: true,
      title: '批量删除渠道确认',
      message: `确定要删除选中的 ${selectedIds.length} 个交付支出渠道吗？`,
      type: 'danger',
      confirmText: `删除选中的 ${selectedIds.length} 项`,
      cancelText: '取消',
      onConfirm: () => {
        setChannelList((prev) => prev.filter((c) => !selectedIds.includes(c.id)))
        setSelectedIds([])
        closeConfirmModal()
      }
    })
  }

  const handleSaveToDatabase = async (): Promise<void> => {
    setSaving(true)
    try {
      const prepared: PaymentChannelItem[] = channelList.map((c) => ({
        ...c,
        u_date: getToday8()
      }))
      await savePaymentChannels(prepared)
      setNewlyAddedIds([])
      showAlert('保存成功', '提示', 'success')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showAlert(`保存失败：${message}`, '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const filteredChannels = channelList.filter((c) => {
    const matchKeyword =
      !appliedSearchQuery.trim() ||
      c.name.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase()) ||
      c.by1.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase()) ||
      c.by2.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase()) ||
      c.id.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase())
    const matchStatus =
      appliedSearchStatus === 'all' ||
      (appliedSearchStatus === 'enabled' && c.start === '启用') ||
      (appliedSearchStatus === 'disabled' && c.start === '停用')
    return matchKeyword && matchStatus
  })

  const totalCount = filteredChannels.length
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize))
  const currentPage = Math.min(Math.max(1, page), totalPages)
  const pagedChannels = filteredChannels.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  )

  const isAllSelected =
    pagedChannels.length > 0 && pagedChannels.every((c) => selectedIds.includes(c.id))

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-surface-bg p-6 gap-4">
      <StandardAlertModal
        isOpen={alertModal.isOpen}
        title={alertModal.title}
        message={alertModal.message}
        type={alertModal.type}
        confirmText={alertModal.confirmText}
        onClose={closeAlertModal}
      />

      <StandardConfirmModal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmText={confirmModal.confirmText}
        cancelText={confirmModal.cancelText}
        type={confirmModal.type}
        onConfirm={confirmModal.onConfirm}
        onCancel={closeConfirmModal}
      />

      <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-h2-header text-text-main font-bold">交付支出渠道</h1>
          <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
            共 {channelList.length} 个交付支出渠道
          </span>
        </div>

        <div className="flex items-center flex-wrap gap-3">
          <div className="flex items-center gap-1.5">
            <div className="relative">
              <span
                className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline"
                style={{ fontSize: '18px' }}
              >
                search
              </span>
              <input
                type="text"
                placeholder="搜索名称、省份、城市或ID…"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setAppliedSearchQuery(searchDraft)
                    setAppliedSearchStatus(searchStatusDraft)
                    setPage(1)
                  }
                }}
                className="pl-9 pr-8 py-1.5 bg-white border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary w-52 transition-all"
              />
              {searchDraft && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchDraft('')
                    setAppliedSearchQuery('')
                    setPage(1)
                  }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-outline hover:text-text-main cursor-pointer"
                  title="清空搜索"
                >
                  <span className="material-symbols-outlined text-[16px]">close</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-body-sm text-text-muted whitespace-nowrap">状态</span>
              <select
                value={searchStatusDraft}
                onChange={(e) =>
                  setSearchStatusDraft(e.target.value as 'all' | 'enabled' | 'disabled')
                }
                className="px-2.5 py-1.5 bg-white border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary w-24 cursor-pointer transition-all"
              >
                <option value="all">全部</option>
                <option value="enabled">启用</option>
                <option value="disabled">停用</option>
              </select>
            </div>

            <button
              type="button"
              onClick={() => {
                setAppliedSearchQuery(searchDraft)
                setAppliedSearchStatus(searchStatusDraft)
                setPage(1)
              }}
              className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
            >
              <span className="material-symbols-outlined text-[16px]">search</span>
              查询
            </button>
          </div>

          <button
            type="button"
            onClick={handleSaveToDatabase}
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-all shadow-xs cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">save</span>
            {saving ? '保存中…' : '保存'}
          </button>

          <button
            type="button"
            onClick={handleDeleteSelected}
            disabled={selectedIds.length === 0}
            className={
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
              (selectedIds.length > 0
                ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
            }
          >
            <span className="material-symbols-outlined text-[18px]">delete</span>
            删除 {selectedIds.length > 0 ? `(${selectedIds.length})` : ''}
          </button>

          <button
            type="button"
            onClick={handleAddNewChannel}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            新增交付渠道
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
        <div className="flex-1 overflow-auto">
          <table className="min-w-[900px] w-full text-left border-collapse">
            <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
              <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                <th className="py-3 px-4 w-12 min-w-[48px] text-center">
                  <input
                    type="checkbox"
                    checked={isAllSelected}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedIds((prev) => [
                          ...new Set([...prev, ...pagedChannels.map((c) => c.id)])
                        ])
                      } else {
                        const pageIds = pagedChannels.map((c) => c.id)
                        setSelectedIds((prev) => prev.filter((id) => !pageIds.includes(id)))
                      }
                    }}
                    className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                  />
                </th>
                <th className="py-3 px-4 w-24 min-w-[90px] text-center">编号</th>
                <th className="py-3 px-4 min-w-[200px]">名称</th>
                <th className="py-3 px-4 w-32 min-w-[120px]">省份</th>
                <th className="py-3 px-4 w-32 min-w-[120px]">城市</th>
                <th className="py-3 px-4 min-w-[200px]">医院</th>
                <th className="py-3 px-4 w-32 min-w-[110px] text-center">状态</th>
                <th className="py-3 px-4 w-40 min-w-[140px] text-center">时间</th>
                <th className="py-3 px-4 w-16 min-w-[60px] text-center">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle text-body-sm">
              {pagedChannels.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-16 text-center text-text-muted">
                    <span className="material-symbols-outlined text-[40px] text-outline block mb-2">
                      inbox
                    </span>
                    暂无交付支出渠道数据，点击上方“新增交付渠道”开始配置
                  </td>
                </tr>
              ) : (
                pagedChannels.map((item, idx) => {
                  const isNewlyAdded = newlyAddedIds.includes(item.id)
                  const isSelected = selectedIds.includes(item.id)

                  const rowBgClass = isSelected
                    ? 'bg-primary/10 border-l-4 border-l-primary hover:bg-primary/15'
                    : isNewlyAdded
                      ? 'bg-emerald-50/90 hover:bg-emerald-100/80 border-l-4 border-l-action-green'
                      : 'hover:bg-surface-container-low/50 border-l-4 border-l-transparent'

                  return (
                    <tr
                      key={item.id + '_' + idx}
                      className={'transition-colors ' + rowBgClass}
                    >
                      <td className="py-3 px-4 text-center">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedIds((prev) => [...prev, item.id])
                            } else {
                              setSelectedIds((prev) => prev.filter((id) => id !== item.id))
                            }
                          }}
                          className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                        />
                      </td>
                      <td className="py-2.5 px-3 font-mono-data text-center text-body-sm text-text-muted font-medium whitespace-nowrap">
                        {item.id}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <input
                          type="text"
                          value={item.name}
                          onChange={(e) => updateField(item.id, 'name', e.target.value)}
                          placeholder="渠道名称…"
                          className="w-full px-3 py-1.5 text-body-sm font-medium rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                        />
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <input
                          type="text"
                          value={item.by1}
                          onChange={(e) => updateField(item.id, 'by1', e.target.value)}
                          placeholder="省份编码…"
                          className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                        />
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <input
                          type="text"
                          value={item.by2}
                          onChange={(e) => updateField(item.id, 'by2', e.target.value)}
                          placeholder="城市编码…"
                          className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                        />
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <select
                          value={item.yy}
                          onChange={(e) => updateField(item.id, 'yy', e.target.value)}
                          className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer transition-all shadow-2xs"
                        >
                          <option value="">未绑定医院</option>
                          {hospitals.map((h) => (
                            <option key={h.id} value={h.id}>
                              {h.name} ({h.id})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2.5 px-4 text-center whitespace-nowrap">
                        <StandardStateSelect
                          value={item.start}
                          onChange={(val) => updateField(item.id, 'start', val)}
                        />
                      </td>
                      <td className="py-3 px-5 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                        {formatDisplayDate(item.u_date)}
                      </td>
                      <td className="py-2.5 px-4 text-center whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => handleDeleteChannel(item.id, item.name)}
                          className="inline-flex items-center justify-center p-1.5 rounded-md text-outline hover:text-error hover:bg-red-50 transition-colors cursor-pointer"
                          title="删除此渠道"
                        >
                          <span className="material-symbols-outlined text-[18px]">delete</span>
                        </button>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        <StandardPaginationBar
          totalCount={totalCount}
          currentPage={currentPage}
          pageSize={pageSize}
          onPageChange={(p) => setPage(p)}
          onPageSizeChange={(s) => setPageSize(s)}
        />
      </div>
    </div>
  )
}
