import React, { useState, useEffect, useCallback } from 'react'
import {
  InternalProductItem,
  SubProductItem,
  fetchInternalProducts,
  saveInternalProducts,
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

export default function InternalProductView(): React.JSX.Element {
  const [productList, setProductList] = useState<InternalProductItem[]>([])
  const [newlyAddedProdIds, setNewlyAddedProdIds] = useState<string[]>([])
  const [newlyAddedSubIds, setNewlyAddedSubIds] = useState<string[]>([])

  const [loading, setLoading] = useState<boolean>(true)
  const [saving, setSaving] = useState<boolean>(false)

  const [alertModal, setAlertModal] = useState<AlertModalConfig>({
    isOpen: false,
    title: '',
    message: '',
    type: 'info'
  })

  const [drilldownProductId, setDrilldownProductId] = useState<string | null>(null)

  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([])
  const [selectedSubIds, setSelectedSubIds] = useState<string[]>([])

  const [searchDraft, setSearchDraft] = useState('')
  const [searchStatusDraft, setSearchStatusDraft] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [appliedSearchQuery, setAppliedSearchQuery] = useState('')
  const [appliedSearchStatus, setAppliedSearchStatus] = useState<'all' | 'enabled' | 'disabled'>('all')

  const [subSearchDraft, setSubSearchDraft] = useState('')
  const [subSearchStatusDraft, setSubSearchStatusDraft] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [appliedSubSearchQuery, setAppliedSubSearchQuery] = useState('')
  const [appliedSubSearchStatus, setAppliedSubSearchStatus] = useState<'all' | 'enabled' | 'disabled'>('all')

  const [productPage, setProductPage] = useState<number>(1)
  const [productPageSize, setProductPageSize] = useState<number>(10)

  const [subPage, setSubPage] = useState<number>(1)
  const [subPageSize, setSubPageSize] = useState<number>(10)

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
      const productsData = await fetchInternalProducts()
      const normalizedProducts: InternalProductItem[] = productsData.map((p) => ({
        ...p,
        subProducts: (p.subProducts || []).map((s) => ({
          ...s,
          xh: s.xh || s.id.slice(-4)
        }))
      }))
      setProductList(normalizedProducts)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showAlert(`加载产品数据失败：${message}`, '加载异常', 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  const activeDrilldownProduct = productList.find((p) => p.id === drilldownProductId) || null

  const updateProductField = (id: string, field: keyof InternalProductItem, value: string): void => {
    setProductList((prev) =>
      prev.map((item) => {
        if (item.id === id) {
          return { ...item, [field]: value }
        }
        return item
      })
    )
  }

  const updateSubProductField = (subId: string, field: keyof SubProductItem, value: string): void => {
    if (!drilldownProductId) return
    setProductList((prev) =>
      prev.map((p) => {
        if (p.id === drilldownProductId) {
          const updatedSubs = (p.subProducts || []).map((s) => {
            if (s.id === subId) {
              return { ...s, [field]: value }
            }
            return s
          })
          return { ...p, subProducts: updatedSubs }
        }
        return p
      })
    )
  }

  const handleAddNewProduct = (): void => {
    const existingIds = productList
      .map((p) => parseInt(p.id, 10))
      .filter((n) => !isNaN(n))
    const maxId = existingIds.length > 0 ? Math.max(...existingIds) : 0
    const newId = String(maxId + 1).padStart(4, '0')

    const newProduct: InternalProductItem = {
      id: newId,
      name: `新产品_${newId}`,
      ms: '产品体系说明',
      lx: '常规服务',
      state: '启用',
      c_date: getToday8(),
      u_date: getToday8(),
      subProducts: []
    }

    setProductList((prev) => [newProduct, ...prev])
    setNewlyAddedProdIds((prev) => [...prev, newId])
    setProductPage(1)
  }

  const handleAddNewSubProduct = (): void => {
    if (!drilldownProductId || !activeDrilldownProduct) return
    const subList = activeDrilldownProduct.subProducts || []
    const existingXhs = subList
      .map((s) => parseInt(s.xh || s.id.slice(-4), 10))
      .filter((n) => !isNaN(n))
    const maxXh = existingXhs.length > 0 ? Math.max(...existingXhs) : 0
    const newXh = String(maxXh + 1).padStart(4, '0')
    const fullId = `${drilldownProductId}${newXh}`

    const newSub: SubProductItem = {
      id: fullId,
      xh: newXh,
      id_yj: drilldownProductId,
      name: `子产品_${newXh}`,
      state: '启用',
      u_date: getToday8()
    }

    setProductList((prev) =>
      prev.map((p) => {
        if (p.id === drilldownProductId) {
          return {
            ...p,
            subProducts: [newSub, ...(p.subProducts || [])]
          }
        }
        return p
      })
    )
    setNewlyAddedSubIds((prev) => [...prev, fullId])
    setSubPage(1)
  }

  const handleDeleteProduct = (id: string, name: string): void => {
    const p = productList.find((item) => item.id === id)
    const subCount = p?.subProducts?.length || 0

    setConfirmModal({
      isOpen: true,
      title: '删除产品确认',
      message:
        subCount > 0
          ? `确定要删除产品【${name || id}】吗？\n该产品下包含 ${subCount} 个关联子产品，删除后将一并移除！`
          : `确定要删除产品【${name || id}】吗？`,
      type: 'danger',
      confirmText: '确认删除',
      cancelText: '取消',
      onConfirm: () => {
        setProductList((prev) => prev.filter((item) => item.id !== id))
        setSelectedProductIds((prev) => prev.filter((sid) => sid !== id))
        closeConfirmModal()
      }
    })
  }

  const handleDeleteSelectedProducts = (): void => {
    if (selectedProductIds.length === 0) {
      showAlert('请先勾选需要删除的产品', '操作提示', 'warning')
      return
    }

    setConfirmModal({
      isOpen: true,
      title: '批量删除产品确认',
      message: `确定要删除选中的 ${selectedProductIds.length} 个产品吗？`,
      type: 'danger',
      confirmText: `删除选中的 ${selectedProductIds.length} 个产品`,
      cancelText: '取消',
      onConfirm: () => {
        setProductList((prev) => prev.filter((item) => !selectedProductIds.includes(item.id)))
        setSelectedProductIds([])
        closeConfirmModal()
      }
    })
  }

  const handleDeleteSubProduct = (subId: string, subName: string): void => {
    if (!drilldownProductId) return
    setConfirmModal({
      isOpen: true,
      title: '删除子产品确认',
      message: `确定要删除子产品【${subName || subId}】吗？`,
      type: 'danger',
      confirmText: '确认删除',
      cancelText: '取消',
      onConfirm: () => {
        setProductList((prev) =>
          prev.map((p) => {
            if (p.id === drilldownProductId) {
              return {
                ...p,
                subProducts: (p.subProducts || []).filter((s) => s.id !== subId)
              }
            }
            return p
          })
        )
        setSelectedSubIds((prev) => prev.filter((id) => id !== subId))
        closeConfirmModal()
      }
    })
  }

  const handleDeleteSelectedSubProducts = (): void => {
    if (selectedSubIds.length === 0 || !drilldownProductId) {
      showAlert('请先勾选需要删除的子产品', '操作提示', 'warning')
      return
    }

    setConfirmModal({
      isOpen: true,
      title: '批量删除子产品确认',
      message: `确定要删除选中的 ${selectedSubIds.length} 个子产品吗？`,
      type: 'danger',
      confirmText: `删除选中的 ${selectedSubIds.length} 项`,
      cancelText: '取消',
      onConfirm: () => {
        setProductList((prev) =>
          prev.map((p) => {
            if (p.id === drilldownProductId) {
              return {
                ...p,
                subProducts: (p.subProducts || []).filter((s) => !selectedSubIds.includes(s.id))
              }
            }
            return p
          })
        )
        setSelectedSubIds([])
        closeConfirmModal()
      }
    })
  }

  const handleSaveToDatabase = async (): Promise<void> => {
    setSaving(true)
    try {
      const prepared: InternalProductItem[] = productList.map((p) => ({
        ...p,
        u_date: getToday8(),
        subProducts: (p.subProducts || []).map((s) => ({
          ...s,
          id: `${p.id}${s.xh || s.id.slice(-4)}`,
          xh: s.xh || s.id.slice(-4),
          id_yj: p.id,
          u_date: getToday8()
        }))
      }))
      await saveInternalProducts(prepared)
      setNewlyAddedProdIds([])
      setNewlyAddedSubIds([])
      showAlert('保存成功', '提示', 'success')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showAlert(`保存失败：${message}`, '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const filteredProducts = productList.filter((p) => {
    const matchKeyword =
      !appliedSearchQuery.trim() ||
      p.name.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase()) ||
      p.ms.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase()) ||
      p.lx.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase()) ||
      p.id.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase())
    const matchStatus =
      appliedSearchStatus === 'all' ||
      (appliedSearchStatus === 'enabled' && p.state === '启用') ||
      (appliedSearchStatus === 'disabled' && p.state === '停用')
    return matchKeyword && matchStatus
  })

  const totalProductCount = filteredProducts.length
  const totalProductPages = Math.max(1, Math.ceil(totalProductCount / productPageSize))
  const currentProductPage = Math.min(Math.max(1, productPage), totalProductPages)
  const pagedProducts = filteredProducts.slice(
    (currentProductPage - 1) * productPageSize,
    currentProductPage * productPageSize
  )

  const isAllCurrentPageProductsSelected =
    pagedProducts.length > 0 && pagedProducts.every((p) => selectedProductIds.includes(p.id))

  const allFilteredSubs = (activeDrilldownProduct?.subProducts || []).filter((s) => {
    const matchKeyword =
      !appliedSubSearchQuery.trim() ||
      s.name.toLowerCase().includes(appliedSubSearchQuery.trim().toLowerCase()) ||
      (s.xh || s.id).toLowerCase().includes(appliedSubSearchQuery.trim().toLowerCase())
    const matchStatus =
      appliedSubSearchStatus === 'all' ||
      (appliedSubSearchStatus === 'enabled' && s.state === '启用') ||
      (appliedSubSearchStatus === 'disabled' && s.state === '停用')
    return matchKeyword && matchStatus
  })

  const totalSubCount = allFilteredSubs.length
  const totalSubPages = Math.max(1, Math.ceil(totalSubCount / subPageSize))
  const currentSubPage = Math.min(Math.max(1, subPage), totalSubPages)
  const pagedSubs = allFilteredSubs.slice(
    (currentSubPage - 1) * subPageSize,
    currentSubPage * subPageSize
  )

  const isAllCurrentPageSubsSelected =
    pagedSubs.length > 0 && pagedSubs.every((s) => selectedSubIds.includes(s.id))

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

      {drilldownProductId && activeDrilldownProduct ? (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4 animate-in fade-in duration-150">
          <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setDrilldownProductId(null)}
                className="text-primary hover:text-primary-container font-medium flex items-center gap-0.5 cursor-pointer transition-colors text-body-sm"
              >
                <span className="material-symbols-outlined text-[18px]">arrow_back</span>
                产品管理
              </button>
              <span className="material-symbols-outlined text-[16px] text-outline">chevron_right</span>
              <h1 className="text-h2-header text-text-main font-bold">
                【{activeDrilldownProduct.name || activeDrilldownProduct.id}】子产品
              </h1>
              <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
                共 {activeDrilldownProduct.subProducts?.length || 0} 个子产品
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
                    placeholder="搜索子产品或ID…"
                    value={subSearchDraft}
                    onChange={(e) => setSubSearchDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setAppliedSubSearchQuery(subSearchDraft)
                        setAppliedSubSearchStatus(subSearchStatusDraft)
                        setSubPage(1)
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
                        setSubPage(1)
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
                    setSubPage(1)
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
                onClick={handleDeleteSelectedSubProducts}
                disabled={selectedSubIds.length === 0}
                className={
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
                  (selectedSubIds.length > 0
                    ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                    : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
                }
              >
                <span className="material-symbols-outlined text-[18px]">delete</span>
                删除 {selectedSubIds.length > 0 ? `(${selectedSubIds.length})` : ''}
              </button>

              <button
                type="button"
                onClick={handleAddNewSubProduct}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                新增子产品
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto">
              <table className="min-w-[700px] w-full text-left border-collapse">
                <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
                  <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                    <th className="py-3 px-4 w-12 min-w-[48px] text-center">
                      <input
                        type="checkbox"
                        checked={isAllCurrentPageSubsSelected}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedSubIds((prev) => [
                              ...new Set([...prev, ...pagedSubs.map((s) => s.id)])
                            ])
                          } else {
                            const pageIds = pagedSubs.map((s) => s.id)
                            setSelectedSubIds((prev) => prev.filter((id) => !pageIds.includes(id)))
                          }
                        }}
                        className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                      />
                    </th>
                    <th className="py-3 px-4 w-24 min-w-[90px] text-center">ID</th>
                    <th className="py-3 px-4 min-w-[240px]">子产品名称</th>
                    <th className="py-3 px-4 w-32 min-w-[110px] text-center">状态</th>
                    <th className="py-3 px-4 w-40 min-w-[140px] text-center">更新时间</th>
                    <th className="py-3 px-4 w-16 min-w-[60px] text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle text-body-sm">
                  {pagedSubs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-16 text-center text-text-muted">
                        <span className="material-symbols-outlined text-[40px] text-outline block mb-2">
                          inbox
                        </span>
                        暂无子产品数据，点击上方“新增子产品”开始配置
                      </td>
                    </tr>
                  ) : (
                    pagedSubs.map((sub, idx) => {
                      const isNewlyAdded = newlyAddedSubIds.includes(sub.id)
                      const isSelected = selectedSubIds.includes(sub.id)
                      const displayId = sub.xh || sub.id.slice(-4)

                      const rowBgClass = isSelected
                        ? 'bg-primary/10 border-l-4 border-l-primary hover:bg-primary/15'
                        : isNewlyAdded
                          ? 'bg-emerald-50/90 hover:bg-emerald-100/80 border-l-4 border-l-action-green'
                          : 'hover:bg-surface-container-low/50 border-l-4 border-l-transparent'

                      return (
                        <tr
                          key={sub.id + '_' + idx}
                          className={'transition-colors ' + rowBgClass}
                        >
                          <td className="py-3 px-4 text-center">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedSubIds((prev) => [...prev, sub.id])
                                } else {
                                  setSelectedSubIds((prev) => prev.filter((id) => id !== sub.id))
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
                              value={sub.name}
                              onChange={(e) =>
                                updateSubProductField(sub.id, 'name', e.target.value)
                              }
                              placeholder="子产品名称…"
                              className="w-full px-3 py-1.5 text-body-sm font-medium rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                            />
                          </td>
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <StandardStateSelect
                              value={sub.state}
                              onChange={(val) => updateSubProductField(sub.id, 'state', val)}
                            />
                          </td>
                          <td className="py-3 px-5 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                            {formatDisplayDate(sub.u_date)}
                          </td>
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleDeleteSubProduct(sub.id, sub.name)}
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
              totalCount={totalSubCount}
              currentPage={currentSubPage}
              pageSize={subPageSize}
              onPageChange={(p) => setSubPage(p)}
              onPageSizeChange={(s) => setSubPageSize(s)}
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4">
          <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
            <div className="flex items-center gap-3">
              <h1 className="text-h2-header text-text-main font-bold">产品管理</h1>
              <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
                共 {productList.length} 个产品大类
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
                    placeholder="搜索产品、描述、类型或ID…"
                    value={searchDraft}
                    onChange={(e) => setSearchDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setAppliedSearchQuery(searchDraft)
                        setAppliedSearchStatus(searchStatusDraft)
                        setProductPage(1)
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
                        setProductPage(1)
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
                    setProductPage(1)
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
                onClick={handleDeleteSelectedProducts}
                disabled={selectedProductIds.length === 0}
                className={
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
                  (selectedProductIds.length > 0
                    ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                    : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
                }
              >
                <span className="material-symbols-outlined text-[18px]">delete</span>
                删除 {selectedProductIds.length > 0 ? `(${selectedProductIds.length})` : ''}
              </button>

              <button
                type="button"
                onClick={handleAddNewProduct}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                新增产品
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
                        checked={isAllCurrentPageProductsSelected}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedProductIds((prev) => [
                              ...new Set([...prev, ...pagedProducts.map((p) => p.id)])
                            ])
                          } else {
                            const pageIds = pagedProducts.map((p) => p.id)
                            setSelectedProductIds((prev) => prev.filter((id) => !pageIds.includes(id)))
                          }
                        }}
                        className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                      />
                    </th>
                    <th className="py-3 px-4 w-20 min-w-[80px] text-center">ID</th>
                    <th className="py-3 px-4 w-28 min-w-[110px] text-center">操作</th>
                    <th className="py-3 px-4 min-w-[200px]">产品名称</th>
                    <th className="py-3 px-4 min-w-[240px]">描述</th>
                    <th className="py-3 px-4 w-36 min-w-[130px]">类型</th>
                    <th className="py-3 px-4 w-32 min-w-[110px] text-center">状态</th>
                    <th className="py-3 px-4 w-40 min-w-[140px] text-center">创建时间</th>
                    <th className="py-3 px-4 w-40 min-w-[140px] text-center">更新时间</th>
                    <th className="py-3 px-4 w-16 min-w-[60px] text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle text-body-sm">
                  {pagedProducts.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="py-16 text-center text-text-muted">
                        <span className="material-symbols-outlined text-[40px] text-outline block mb-2">
                          inbox
                        </span>
                        暂无产品数据，点击上方“新增产品”开始配置
                      </td>
                    </tr>
                  ) : (
                    pagedProducts.map((prod, idx) => {
                      const isNewlyAdded = newlyAddedProdIds.includes(prod.id)
                      const isSelected = selectedProductIds.includes(prod.id)

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
                                  setSelectedProductIds((prev) => [...prev, prod.id])
                                } else {
                                  setSelectedProductIds((prev) => prev.filter((id) => id !== prod.id))
                                }
                              }}
                              className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                            />
                          </td>
                          <td className="py-2.5 px-3 font-mono-data text-center text-body-sm text-text-muted font-medium whitespace-nowrap">
                            {prod.id}
                          </td>
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <StandardSubTableBtn
                              label="子产品"
                              onClick={() => {
                                setDrilldownProductId(prod.id)
                                setSubPage(1)
                                setSelectedSubIds([])
                              }}
                            />
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <input
                              type="text"
                              value={prod.name}
                              onChange={(e) => updateProductField(prod.id, 'name', e.target.value)}
                              placeholder="产品名称…"
                              className="w-full px-3 py-1.5 text-body-sm font-medium rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                            />
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <input
                              type="text"
                              value={prod.ms}
                              onChange={(e) => updateProductField(prod.id, 'ms', e.target.value)}
                              placeholder="描述…"
                              className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                            />
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <input
                              type="text"
                              value={prod.lx}
                              onChange={(e) => updateProductField(prod.id, 'lx', e.target.value)}
                              placeholder="类型…"
                              className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                            />
                          </td>
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <StandardStateSelect
                              value={prod.state}
                              onChange={(val) => updateProductField(prod.id, 'state', val)}
                            />
                          </td>
                          <td className="py-3 px-5 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                            {formatDisplayDate(prod.c_date)}
                          </td>
                          <td className="py-3 px-5 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                            {formatDisplayDate(prod.u_date)}
                          </td>
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleDeleteProduct(prod.id, prod.name)}
                              className="inline-flex items-center justify-center p-1.5 rounded-md text-outline hover:text-error hover:bg-red-50 transition-colors cursor-pointer"
                              title="删除此产品"
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
              totalCount={totalProductCount}
              currentPage={currentProductPage}
              pageSize={productPageSize}
              onPageChange={(p) => setProductPage(p)}
              onPageSizeChange={(s) => setProductPageSize(s)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
