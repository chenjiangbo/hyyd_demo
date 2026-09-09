import React, { useState, useEffect, useCallback } from 'react'
import {
  ChannelItem,
  ChannelProductItem,
  InternalProductItem,
  fetchChannels,
  saveChannels,
  fetchInternalProducts,
  formatDisplayDate,
  getToday8
} from '../../api'
import {
  StandardAlertModal,
  StandardConfirmModal,
  StandardStateSelect,
  StandardSubTableBtn,
  StandardPaginationBar,
  AlertModalConfig,
  ConfirmModalConfig
} from './dictComponents'

export default function ChannelView(): React.JSX.Element {
  const [channelList, setChannelList] = useState<ChannelItem[]>([])
  const [productList, setProductList] = useState<InternalProductItem[]>([])
  const [newlyAddedChannelIds, setNewlyAddedChannelIds] = useState<string[]>([])
  const [newlyAddedProdIds, setNewlyAddedProdIds] = useState<string[]>([])

  const [loading, setLoading] = useState<boolean>(true)
  const [saving, setSaving] = useState<boolean>(false)

  const [alertModal, setAlertModal] = useState<AlertModalConfig>({
    isOpen: false,
    title: '',
    message: '',
    type: 'info'
  })

  const [drilldownChannelId, setDrilldownChannelId] = useState<string | null>(null)

  const [selectedChannelIds, setSelectedChannelIds] = useState<string[]>([])
  const [selectedProdIds, setSelectedProdIds] = useState<string[]>([])

  const [searchDraft, setSearchDraft] = useState('')
  const [searchStatusDraft, setSearchStatusDraft] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [appliedSearchQuery, setAppliedSearchQuery] = useState('')
  const [appliedSearchStatus, setAppliedSearchStatus] = useState<'all' | 'enabled' | 'disabled'>('all')

  const [subSearchDraft, setSubSearchDraft] = useState('')
  const [subSearchStatusDraft, setSubSearchStatusDraft] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [appliedSubSearchQuery, setAppliedSubSearchQuery] = useState('')
  const [appliedSubSearchStatus, setAppliedSubSearchStatus] = useState<'all' | 'enabled' | 'disabled'>('all')

  const [channelPage, setChannelPage] = useState<number>(1)
  const [channelPageSize, setChannelPageSize] = useState<number>(10)

  const [prodPage, setProdPage] = useState<number>(1)
  const [prodPageSize, setProdPageSize] = useState<number>(10)

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
      const [channelsData, productsData] = await Promise.all([
        fetchChannels(),
        fetchInternalProducts().catch(() => [])
      ])
      const normalizedChannels: ChannelItem[] = channelsData.map((c) => ({
        ...c,
        products: (c.products || []).map((p) => ({
          ...p,
          xh: p.xh || p.id.slice(-3)
        }))
      }))
      setChannelList(normalizedChannels)
      setProductList(productsData)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showAlert(`加载渠道数据失败：${message}`, '加载异常', 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const activeDrilldownChannel = channelList.find((c) => c.id === drilldownChannelId) || null

  const updateChannelField = (id: string, field: keyof ChannelItem, value: string): void => {
    setChannelList((prev) =>
      prev.map((item) => {
        if (item.id === id) {
          return { ...item, [field]: value }
        }
        return item
      })
    )
  }

  const updateChannelProductField = (
    prodId: string,
    field: keyof ChannelProductItem,
    value: string | number
  ): void => {
    if (!drilldownChannelId) return
    setChannelList((prev) =>
      prev.map((ch) => {
        if (ch.id === drilldownChannelId) {
          const updatedProds = (ch.products || []).map((p) => {
            if (p.id === prodId) {
              const updated = { ...p, [field]: value }
              if (field === 'nbyjcp') {
                updated.nbejcp = ''
              }
              return updated
            }
            return p
          })
          return { ...ch, products: updatedProds }
        }
        return ch
      })
    )
  }

  const handleAddNewChannel = (): void => {
    const existingIds = channelList
      .map((c) => parseInt(c.id, 10))
      .filter((n) => !isNaN(n))
    const maxId = existingIds.length > 0 ? Math.max(...existingIds) : 0
    const newId = String(maxId + 1).padStart(4, '0')

    const newChannel: ChannelItem = {
      id: newId,
      name: `新渠道_${newId}`,
      state: '启用',
      c_date: getToday8(),
      u_date: getToday8(),
      products: []
    }

    setChannelList((prev) => [newChannel, ...prev])
    setNewlyAddedChannelIds((prev) => [...prev, newId])
    setChannelPage(1)
  }

  const handleAddNewChannelProduct = (): void => {
    if (!drilldownChannelId || !activeDrilldownChannel) return
    const subList = activeDrilldownChannel.products || []
    const existingXhs = subList
      .map((s) => parseInt(s.xh || s.id.slice(-3), 10))
      .filter((n) => !isNaN(n))
    const maxXh = existingXhs.length > 0 ? Math.max(...existingXhs) : 0
    const newXh = String(maxXh + 1).padStart(3, '0')
    const fullId = `${drilldownChannelId}${newXh}`

    const defaultYj = productList.length > 0 ? productList[0].id : '0001'
    const defaultEj =
      productList.length > 0 && (productList[0].subProducts?.length ?? 0) > 0
        ? productList[0].subProducts![0].id
        : `${defaultYj}0001`

    const newProd: ChannelProductItem = {
      id: fullId,
      xh: newXh,
      id_yj: drilldownChannelId,
      name: `渠道产品_${newXh}`,
      cpjg: 100,
      nbyjcp: defaultYj,
      nbejcp: defaultEj,
      state: '启用',
      u_date: getToday8()
    }

    setChannelList((prev) =>
      prev.map((ch) => {
        if (ch.id === drilldownChannelId) {
          return {
            ...ch,
            products: [newProd, ...(ch.products || [])]
          }
        }
        return ch
      })
    )
    setNewlyAddedProdIds((prev) => [...prev, fullId])
    setProdPage(1)
  }

  const handleDeleteChannel = (id: string, name: string): void => {
    const ch = channelList.find((c) => c.id === id)
    const subCount = ch?.products?.length || 0

    setConfirmModal({
      isOpen: true,
      title: '删除渠道确认',
      message:
        subCount > 0
          ? `确定要删除渠道【${name || id}】吗？\n该渠道下包含 ${subCount} 个关联产品，删除后将一并移除！`
          : `确定要删除渠道【${name || id}】吗？`,
      type: 'danger',
      confirmText: '确认删除',
      cancelText: '取消',
      onConfirm: () => {
        setChannelList((prev) => prev.filter((c) => c.id !== id))
        setSelectedChannelIds((prev) => prev.filter((sid) => sid !== id))
        closeConfirmModal()
      }
    })
  }

  const handleDeleteSelectedChannels = (): void => {
    if (selectedChannelIds.length === 0) {
      showAlert('请先勾选需要删除的渠道', '操作提示', 'warning')
      return
    }

    setConfirmModal({
      isOpen: true,
      title: '批量删除渠道确认',
      message: `确定要删除选中的 ${selectedChannelIds.length} 个渠道吗？`,
      type: 'danger',
      confirmText: `删除选中的 ${selectedChannelIds.length} 个渠道`,
      cancelText: '取消',
      onConfirm: () => {
        setChannelList((prev) => prev.filter((c) => !selectedChannelIds.includes(c.id)))
        setSelectedChannelIds([])
        closeConfirmModal()
      }
    })
  }

  const handleDeleteChannelProduct = (prodId: string, prodName: string): void => {
    if (!drilldownChannelId) return
    setConfirmModal({
      isOpen: true,
      title: '删除渠道产品确认',
      message: `确定要删除渠道产品【${prodName || prodId}】吗？`,
      type: 'danger',
      confirmText: '确认删除',
      cancelText: '取消',
      onConfirm: () => {
        setChannelList((prev) =>
          prev.map((ch) => {
            if (ch.id === drilldownChannelId) {
              return {
                ...ch,
                products: (ch.products || []).filter((p) => p.id !== prodId)
              }
            }
            return ch
          })
        )
        setSelectedProdIds((prev) => prev.filter((id) => id !== prodId))
        closeConfirmModal()
      }
    })
  }

  const handleDeleteSelectedChannelProducts = (): void => {
    if (selectedProdIds.length === 0 || !drilldownChannelId) {
      showAlert('请先勾选需要删除的渠道产品', '操作提示', 'warning')
      return
    }

    setConfirmModal({
      isOpen: true,
      title: '批量删除渠道产品确认',
      message: `确定要删除选中的 ${selectedProdIds.length} 个渠道产品吗？`,
      type: 'danger',
      confirmText: `删除选中的 ${selectedProdIds.length} 项`,
      cancelText: '取消',
      onConfirm: () => {
        setChannelList((prev) =>
          prev.map((ch) => {
            if (ch.id === drilldownChannelId) {
              return {
                ...ch,
                products: (ch.products || []).filter((p) => !selectedProdIds.includes(p.id))
              }
            }
            return ch
          })
        )
        setSelectedProdIds([])
        closeConfirmModal()
      }
    })
  }

  const handleSaveToDatabase = async (): Promise<void> => {
    setSaving(true)
    try {
      const prepared: ChannelItem[] = channelList.map((c) => ({
        ...c,
        u_date: getToday8(),
        products: (c.products || []).map((p) => ({
          ...p,
          id: `${c.id}${p.xh || p.id.slice(-3)}`,
          xh: p.xh || p.id.slice(-3),
          id_yj: c.id,
          u_date: getToday8()
        }))
      }))
      await saveChannels(prepared)
      setNewlyAddedChannelIds([])
      setNewlyAddedProdIds([])
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
      c.id.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase())
    const matchStatus =
      appliedSearchStatus === 'all' ||
      (appliedSearchStatus === 'enabled' && c.state === '启用') ||
      (appliedSearchStatus === 'disabled' && c.state === '停用')
    return matchKeyword && matchStatus
  })

  const totalChannelCount = filteredChannels.length
  const totalChannelPages = Math.max(1, Math.ceil(totalChannelCount / channelPageSize))
  const currentChannelPage = Math.min(Math.max(1, channelPage), totalChannelPages)
  const pagedChannels = filteredChannels.slice(
    (currentChannelPage - 1) * channelPageSize,
    currentChannelPage * channelPageSize
  )

  const isAllCurrentPageChannelsSelected =
    pagedChannels.length > 0 && pagedChannels.every((c) => selectedChannelIds.includes(c.id))

  const allFilteredProds = (activeDrilldownChannel?.products || []).filter((p) => {
    const matchKeyword =
      !appliedSubSearchQuery.trim() ||
      p.name.toLowerCase().includes(appliedSubSearchQuery.trim().toLowerCase()) ||
      (p.xh || p.id).toLowerCase().includes(appliedSubSearchQuery.trim().toLowerCase())
    const matchStatus =
      appliedSubSearchStatus === 'all' ||
      (appliedSubSearchStatus === 'enabled' && p.state === '启用') ||
      (appliedSubSearchStatus === 'disabled' && p.state === '停用')
    return matchKeyword && matchStatus
  })

  const totalProdCount = allFilteredProds.length
  const totalProdPages = Math.max(1, Math.ceil(totalProdCount / prodPageSize))
  const currentProdPage = Math.min(Math.max(1, prodPage), totalProdPages)
  const pagedProds = allFilteredProds.slice(
    (currentProdPage - 1) * prodPageSize,
    currentProdPage * prodPageSize
  )

  const isAllCurrentPageProdsSelected =
    pagedProds.length > 0 && pagedProds.every((p) => selectedProdIds.includes(p.id))

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-surface-bg">
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

      {drilldownChannelId && activeDrilldownChannel ? (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4 animate-in fade-in duration-150">
          <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setDrilldownChannelId(null)}
                className="text-primary hover:text-primary-container font-medium flex items-center gap-0.5 cursor-pointer transition-colors text-body-sm"
              >
                <span className="material-symbols-outlined text-[18px]">arrow_back</span>
                渠道管理
              </button>
              <span className="material-symbols-outlined text-[16px] text-outline">chevron_right</span>
              <h1 className="text-h2-header text-text-main font-bold">
                【{activeDrilldownChannel.name || activeDrilldownChannel.id}】产品
              </h1>
              <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
                共 {activeDrilldownChannel.products?.length || 0} 个产品
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
                    placeholder="搜索渠道产品或ID…"
                    value={subSearchDraft}
                    onChange={(e) => setSubSearchDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setAppliedSubSearchQuery(subSearchDraft)
                        setAppliedSubSearchStatus(subSearchStatusDraft)
                        setProdPage(1)
                      }
                    }}
                    className="pl-9 pr-8 py-1.5 bg-white border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary w-48 transition-all"
                  />
                  {subSearchDraft && (
                    <button
                      type="button"
                      onClick={() => {
                        setSubSearchDraft('')
                        setAppliedSubSearchQuery('')
                        setProdPage(1)
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
                    value={subSearchStatusDraft}
                    onChange={(e) =>
                      setSubSearchStatusDraft(e.target.value as 'all' | 'enabled' | 'disabled')
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
                    setAppliedSubSearchQuery(subSearchDraft)
                    setAppliedSubSearchStatus(subSearchStatusDraft)
                    setProdPage(1)
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
                onClick={handleDeleteSelectedChannelProducts}
                disabled={selectedProdIds.length === 0}
                className={
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
                  (selectedProdIds.length > 0
                    ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                    : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
                }
              >
                <span className="material-symbols-outlined text-[18px]">delete</span>
                删除 {selectedProdIds.length > 0 ? `(${selectedProdIds.length})` : ''}
              </button>

              <button
                type="button"
                onClick={handleAddNewChannelProduct}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                新增渠道产品
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto">
              <table className="min-w-[1000px] w-full text-left border-collapse">
                <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
                  <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                    <th className="py-3 px-4 w-12 min-w-[48px] text-center">
                      <input
                        type="checkbox"
                        checked={isAllCurrentPageProdsSelected}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedProdIds((prev) => [
                              ...new Set([...prev, ...pagedProds.map((p) => p.id)])
                            ])
                          } else {
                            const pageIds = pagedProds.map((p) => p.id)
                            setSelectedProdIds((prev) => prev.filter((id) => !pageIds.includes(id)))
                          }
                        }}
                        className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                      />
                    </th>
                    <th className="py-3 px-4 w-20 min-w-[80px] text-center">ID</th>
                    <th className="py-3 px-4 min-w-[200px]">产品名称</th>
                    <th className="py-3 px-4 w-32 min-w-[120px]">产品价格</th>
                    <th className="py-3 px-4 min-w-[180px]">内部一级产品</th>
                    <th className="py-3 px-4 min-w-[180px]">内部二级产品</th>
                    <th className="py-3 px-4 w-32 min-w-[110px] text-center">状态</th>
                    <th className="py-3 px-4 w-40 min-w-[140px] text-center">更新时间</th>
                    <th className="py-3 px-4 w-16 min-w-[60px] text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle text-body-sm">
                  {pagedProds.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-16 text-center text-text-muted">
                        <span className="material-symbols-outlined text-[40px] text-outline block mb-2">
                          inbox
                        </span>
                        暂无渠道产品数据，点击上方“新增渠道产品”开始配置
                      </td>
                    </tr>
                  ) : (
                    pagedProds.map((prod, idx) => {
                      const isNewlyAdded = newlyAddedProdIds.includes(prod.id)
                      const isSelected = selectedProdIds.includes(prod.id)
                      const displayId = prod.xh || prod.id.slice(-3)

                      const selectedParentProd = productList.find((p) => p.id === prod.nbyjcp)
                      const availableSubProds = selectedParentProd?.subProducts || []

                      const rowBgClass = isSelected
                        ? 'bg-primary/10 border-l-4 border-l-primary hover:bg-primary/15'
                        : isNewlyAdded
                          ? 'bg-emerald-50/90 hover:bg-emerald-100/80 border-l-4 border-l-action-green'
                          : 'hover:bg-surface-container-low/50 border-l-4 border-l-transparent'

                      return (
                        <tr
                          key={prod.id + '_' + idx}
                          className={'transition-colors ' + rowBgClass}
                        >
                          <td className="py-3 px-4 text-center">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedProdIds((prev) => [...prev, prod.id])
                                } else {
                                  setSelectedProdIds((prev) => prev.filter((id) => id !== prod.id))
                                }
                              }}
                              className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                            />
                          </td>
                          <td className="py-2.5 px-3 font-mono-data text-center text-body-sm text-text-muted font-medium whitespace-nowrap">
                            {displayId}
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <input
                              type="text"
                              value={prod.name}
                              onChange={(e) =>
                                updateChannelProductField(prod.id, 'name', e.target.value)
                              }
                              placeholder="渠道产品名称…"
                              className="w-full px-3 py-1.5 text-body-sm font-medium rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                            />
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <input
                              type="number"
                              value={prod.cpjg}
                              onChange={(e) =>
                                updateChannelProductField(
                                  prod.id,
                                  'cpjg',
                                  parseFloat(e.target.value) || 0
                                )
                              }
                              placeholder="价格…"
                              className="w-full px-3 py-1.5 text-body-sm font-semibold text-primary rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                            />
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <select
                              value={prod.nbyjcp}
                              onChange={(e) =>
                                updateChannelProductField(prod.id, 'nbyjcp', e.target.value)
                              }
                              className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer transition-all shadow-2xs"
                            >
                              <option value="">未选择一级产品</option>
                              {productList.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name} ({p.id})
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <select
                              value={prod.nbejcp}
                              onChange={(e) =>
                                updateChannelProductField(prod.id, 'nbejcp', e.target.value)
                              }
                              className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer transition-all shadow-2xs"
                            >
                              <option value="">未选择二级产品</option>
                              {availableSubProds.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name} ({s.xh || s.id.slice(-4)})
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <StandardStateSelect
                              value={prod.state}
                              onChange={(val) =>
                                updateChannelProductField(prod.id, 'state', val)
                              }
                            />
                          </td>
                          <td className="py-3 px-5 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                            {formatDisplayDate(prod.u_date)}
                          </td>
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleDeleteChannelProduct(prod.id, prod.name)}
                              className="inline-flex items-center justify-center p-1.5 rounded-md text-outline hover:text-error hover:bg-red-50 transition-colors cursor-pointer"
                              title="删除此项"
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
              totalCount={totalProdCount}
              currentPage={currentProdPage}
              pageSize={prodPageSize}
              onPageChange={(p) => setProdPage(p)}
              onPageSizeChange={(s) => setProdPageSize(s)}
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4">
          <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
            <div className="flex items-center gap-3">
              <h1 className="text-h2-header text-text-main font-bold">渠道管理</h1>
              <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
                共 {channelList.length} 个渠道
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
                    placeholder="搜索渠道名称或ID…"
                    value={searchDraft}
                    onChange={(e) => setSearchDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setAppliedSearchQuery(searchDraft)
                        setAppliedSearchStatus(searchStatusDraft)
                        setChannelPage(1)
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
                        setChannelPage(1)
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
                    setChannelPage(1)
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
                onClick={handleDeleteSelectedChannels}
                disabled={selectedChannelIds.length === 0}
                className={
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
                  (selectedChannelIds.length > 0
                    ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                    : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
                }
              >
                <span className="material-symbols-outlined text-[18px]">delete</span>
                删除 {selectedChannelIds.length > 0 ? `(${selectedChannelIds.length})` : ''}
              </button>

              <button
                type="button"
                onClick={handleAddNewChannel}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                新增渠道
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto">
              <table className="min-w-[800px] w-full text-left border-collapse">
                <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
                  <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                    <th className="py-3 px-4 w-12 min-w-[48px] text-center">
                      <input
                        type="checkbox"
                        checked={isAllCurrentPageChannelsSelected}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedChannelIds((prev) => [
                              ...new Set([...prev, ...pagedChannels.map((c) => c.id)])
                            ])
                          } else {
                            const pageIds = pagedChannels.map((c) => c.id)
                            setSelectedChannelIds((prev) => prev.filter((id) => !pageIds.includes(id)))
                          }
                        }}
                        className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                      />
                    </th>
                    <th className="py-3 px-4 w-24 min-w-[90px] text-center">ID</th>
                    <th className="py-3 px-4 w-28 min-w-[110px] text-center">操作</th>
                    <th className="py-3 px-4 min-w-[220px]">渠道名称</th>
                    <th className="py-3 px-4 w-32 min-w-[110px] text-center">状态</th>
                    <th className="py-3 px-4 w-40 min-w-[140px] text-center">创建时间</th>
                    <th className="py-3 px-4 w-40 min-w-[140px] text-center">更新时间</th>
                    <th className="py-3 px-4 w-16 min-w-[60px] text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle text-body-sm">
                  {pagedChannels.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-16 text-center text-text-muted">
                        <span className="material-symbols-outlined text-[40px] text-outline block mb-2">
                          inbox
                        </span>
                        暂无渠道数据，点击上方“新增渠道”开始配置
                      </td>
                    </tr>
                  ) : (
                    pagedChannels.map((ch, idx) => {
                      const isNewlyAdded = newlyAddedChannelIds.includes(ch.id)
                      const isSelected = selectedChannelIds.includes(ch.id)

                      const rowBgClass = isSelected
                        ? 'bg-primary/10 border-l-4 border-l-primary hover:bg-primary/15'
                        : isNewlyAdded
                          ? 'bg-emerald-50/90 hover:bg-emerald-100/80 border-l-4 border-l-action-green'
                          : 'hover:bg-surface-container-low/50 border-l-4 border-l-transparent'

                      return (
                        <tr
                          key={ch.id + '_' + idx}
                          className={'transition-colors ' + rowBgClass}
                        >
                          <td className="py-3 px-4 text-center">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedChannelIds((prev) => [...prev, ch.id])
                                } else {
                                  setSelectedChannelIds((prev) => prev.filter((id) => id !== ch.id))
                                }
                              }}
                              className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                            />
                          </td>
                          <td className="py-2.5 px-3 font-mono-data text-center text-body-sm text-text-muted font-medium whitespace-nowrap">
                            {ch.id}
                          </td>
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <StandardSubTableBtn
                              label="产品"
                              onClick={() => {
                                setDrilldownChannelId(ch.id)
                                setProdPage(1)
                                setSelectedProdIds([])
                              }}
                            />
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <input
                              type="text"
                              value={ch.name}
                              onChange={(e) => updateChannelField(ch.id, 'name', e.target.value)}
                              placeholder="渠道名称…"
                              className="w-full px-3 py-1.5 text-body-sm font-medium rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                            />
                          </td>
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <StandardStateSelect
                              value={ch.state}
                              onChange={(val) => updateChannelField(ch.id, 'state', val)}
                            />
                          </td>
                          <td className="py-3 px-5 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                            {formatDisplayDate(ch.c_date)}
                          </td>
                          <td className="py-3 px-5 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                            {formatDisplayDate(ch.u_date)}
                          </td>
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleDeleteChannel(ch.id, ch.name)}
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
              totalCount={totalChannelCount}
              currentPage={currentChannelPage}
              pageSize={channelPageSize}
              onPageChange={(p) => setChannelPage(p)}
              onPageSizeChange={(s) => setChannelPageSize(s)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
