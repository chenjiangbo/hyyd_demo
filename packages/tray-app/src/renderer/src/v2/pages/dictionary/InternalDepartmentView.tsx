import React, { useState, useEffect, useCallback } from 'react'
import {
  DepartmentItem,
  SubDepartmentItem,
  fetchDepartments,
  saveDepartments
} from '../../api'

function getTodayString(): string {
  const d = new Date()
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

interface ConfirmModalConfig {
  isOpen: boolean
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  type?: 'primary' | 'danger'
  onConfirm: () => void
}

interface AlertModalConfig {
  isOpen: boolean
  title: string
  message: string
  type: 'warning' | 'error' | 'success' | 'info'
  confirmText?: string
  onClose?: () => void
}

export default function InternalDepartmentView(): React.JSX.Element {
  // 主数据与持久化快照（对比快照以呈现编辑高亮）
  const [deptList, setDeptList] = useState<DepartmentItem[]>([])
  const [savedDeptSnapshot, setSavedDeptSnapshot] = useState<DepartmentItem[]>([])
  const [newlyAddedDeptIds, setNewlyAddedDeptIds] = useState<string[]>([])
  const [newlyAddedSubIds, setNewlyAddedSubIds] = useState<string[]>([])

  // 加载与保存状态
  const [loading, setLoading] = useState<boolean>(true)
  const [saving, setSaving] = useState<boolean>(false)

  // 统一显式操作提示弹窗
  const [alertModal, setAlertModal] = useState<AlertModalConfig>({
    isOpen: false,
    title: '',
    message: '',
    type: 'info'
  })

  // 下钻状态：当前查看的一级科室ID
  const [drilldownDeptId, setDrilldownDeptId] = useState<string | null>(null)

  // 勾选状态
  const [selectedDeptIds, setSelectedDeptIds] = useState<string[]>([])
  const [selectedSubIds, setSelectedSubIds] = useState<string[]>([])

  // 主科室搜索态（关键词 + 状态：草稿 vs 生效）
  const [searchDraft, setSearchDraft] = useState('')
  const [searchStatusDraft, setSearchStatusDraft] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [appliedSearchQuery, setAppliedSearchQuery] = useState('')
  const [appliedSearchStatus, setAppliedSearchStatus] = useState<'all' | 'enabled' | 'disabled'>('all')

  // 细分科室搜索态（草稿 vs 生效）
  const [subSearchNameDraft, setSubSearchNameDraft] = useState('')
  const [subSearchStatusDraft, setSubSearchStatusDraft] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [appliedSubSearchName, setAppliedSubSearchName] = useState('')
  const [appliedSubSearchStatus, setAppliedSubSearchStatus] = useState<'all' | 'enabled' | 'disabled'>('all')

  // 主科室分页状态（支持 10 / 20 / 50 / 100）
  const [deptPage, setDeptPage] = useState<number>(1)
  const [deptPageSize, setDeptPageSize] = useState<number>(10)
  const [deptJumpPage, setDeptJumpPage] = useState<string>('')

  // 细分科室分页状态（支持 10 / 20 / 50 / 100）
  const [subDeptPage, setSubDeptPage] = useState<number>(1)
  const [subDeptPageSize, setSubDeptPageSize] = useState<number>(10)
  const [subDeptJumpPage, setSubDeptJumpPage] = useState<string>('')

  // 二次确认弹窗
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
    const defaultTitle =
      title ||
      (type === 'warning'
        ? '操作警告'
        : type === 'error'
          ? '错误提示'
          : type === 'success'
            ? '操作成功'
            : '系统提示')
    setAlertModal({
      isOpen: true,
      title: defaultTitle,
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

  // 仅操作成功提示（success）在 1s 后自动关闭，警告、错误与信息提示需用户手动点击确认
  useEffect(() => {
    if (!alertModal.isOpen || alertModal.type !== 'success') return
    const timer = setTimeout(() => {
      closeAlertModal()
      if (alertModal.onClose) alertModal.onClose()
    }, 1000)
    return () => clearTimeout(timer)
  }, [alertModal.isOpen, alertModal.type, alertModal.onClose])

  // 从后端数据库加载科室列表
  const loadDataFromDb = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchDepartments()
      setDeptList(data)
      setSavedDeptSnapshot(JSON.parse(JSON.stringify(data)))
      setNewlyAddedDeptIds([])
      setNewlyAddedSubIds([])
      setSelectedDeptIds([])
      setSelectedSubIds([])
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showAlert(`读取科室数据失败：${message}`, '加载失败', 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDataFromDb()
  }, [loadDataFromDb])

  // 执行删除时直接同步保存至数据库
  const persistDeleteDeptList = async (nextList: DepartmentItem[]): Promise<void> => {
    setSaving(true)
    try {
      await saveDepartments(nextList)
      setDeptList(nextList)
      setSavedDeptSnapshot(JSON.parse(JSON.stringify(nextList)))
      showAlert('删除成功', '提示', 'success')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showAlert(`删除失败：${message}`, '删除失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  // ─── 1. 一级科室表单变更 ───
  const handleDeptFieldChange = (
    index: number,
    field: keyof DepartmentItem,
    value: string
  ): void => {
    const today = getTodayString()
    const next = [...deptList]
    const item = { ...next[index], [field]: value, updatedAt: today }
    next[index] = item
    setDeptList(next)
  }

  const handleAddNewDepartment = (): void => {
    const today = getTodayString()
    const maxNum = deptList.reduce((max, item) => {
      const n = parseInt(item.id, 10)
      return isNaN(n) ? max : Math.max(max, n)
    }, 0)
    const nextId = String(maxNum + 1).padStart(4, '0')

    const newDept: DepartmentItem = {
      id: nextId,
      name: '',
      desc: '',
      status: 'enabled',
      createdAt: today,
      updatedAt: today,
      subDepartments: []
    }

    setDeptList([...deptList, newDept])
    setNewlyAddedDeptIds((prev) => [...prev, nextId])

    // 自动跳转到新行所在的最后一页
    const nextTotalCount = deptList.length + 1
    const nextTotalPages = Math.ceil(nextTotalCount / deptPageSize)
    setDeptPage(nextTotalPages)
  }

  const handleDeleteSingleDept = (deptId: string, deptName: string): void => {
    const target = deptList.find((d) => d.id === deptId)
    const hasChildren = (target?.subDepartments || []).length > 0

    if (hasChildren) {
      showAlert(
        `科室【${deptName || deptId}】下存在 ${target?.subDepartments.length} 个细分科室，不允许直接删除！\n\n请先点击「细分科室」进入并删除所有下属细分科室后再删除该大类。`,
        '禁止删除',
        'warning'
      )
      return
    }

    setConfirmModal({
      isOpen: true,
      title: '删除科室确认',
      message: `确定要删除科室【${deptName || deptId}】（ID: ${deptId}）吗？`,
      confirmText: '确认删除',
      cancelText: '取消',
      type: 'danger',
      onConfirm: async () => {
        closeConfirmModal()
        const next = deptList.filter((d) => d.id !== deptId)
        setNewlyAddedDeptIds((prev) => prev.filter((id) => id !== deptId))
        setSelectedDeptIds((prev) => prev.filter((id) => id !== deptId))
        await persistDeleteDeptList(next)
      }
    })
  }

  const handleDeleteSelectedDepts = (): void => {
    if (selectedDeptIds.length === 0) {
      showAlert('请先在表格左侧勾选需要批量删除的科室。', '操作提示', 'info')
      return
    }

    const deptsWithChildren = deptList.filter(
      (d) => selectedDeptIds.includes(d.id) && (d.subDepartments || []).length > 0
    )

    if (deptsWithChildren.length > 0) {
      showAlert(
        `选中的科室中有 ${deptsWithChildren.length} 个存在下级细分科室（如【${deptsWithChildren[0].name || deptsWithChildren[0].id}】），不允许直接删除！\n\n请先清除下级细分科室后再执行批量删除。`,
        '禁止删除',
        'warning'
      )
      return
    }

    const count = selectedDeptIds.length
    setConfirmModal({
      isOpen: true,
      title: '批量删除科室确认',
      message: `确定要删除选中的 ${count} 个科室吗？`,
      confirmText: `确认删除 (${count})`,
      cancelText: '取消',
      type: 'danger',
      onConfirm: async () => {
        closeConfirmModal()
        const next = deptList.filter((d) => !selectedDeptIds.includes(d.id))
        setNewlyAddedDeptIds((prev) => prev.filter((id) => !selectedDeptIds.includes(id)))
        setSelectedDeptIds([])
        await persistDeleteDeptList(next)
      }
    })
  }

  const handleQueryMainDepts = (): void => {
    setAppliedSearchQuery(searchDraft)
    setAppliedSearchStatus(searchStatusDraft)
    setSelectedDeptIds([])
    setDeptPage(1)
  }

  // ─── 2. 细分科室操作 ───
  const activeDrilldownDept = deptList.find((d) => d.id === drilldownDeptId) || null

  const handleSubFieldChange = (
    subIndex: number,
    field: keyof SubDepartmentItem,
    value: string
  ): void => {
    if (!activeDrilldownDept) return
    const today = getTodayString()
    const deptIdx = deptList.findIndex((d) => d.id === activeDrilldownDept.id)
    if (deptIdx === -1) return

    const nextDeptList = [...deptList]
    const targetDept = { ...nextDeptList[deptIdx] }
    const nextSubList = [...targetDept.subDepartments]
    const subItem = { ...nextSubList[subIndex], [field]: value, updatedAt: today }

    // 细分科室序号 (xh) 修改时，自动重构物理主键 id = parentDeptId + xh
    if (field === 'xh') {
      const pId = subItem.parentDeptId || targetDept.id
      subItem.id = `${pId}${value}`
    }

    subItem.updatedAt = today
    nextSubList[subIndex] = subItem
    targetDept.subDepartments = nextSubList
    targetDept.updatedAt = today
    nextDeptList[deptIdx] = targetDept

    setDeptList(nextDeptList)
  }

  const handleAddNewSubDepartment = (): void => {
    if (!activeDrilldownDept) return
    const today = getTodayString()
    const deptIdx = deptList.findIndex((d) => d.id === activeDrilldownDept.id)
    if (deptIdx === -1) return

    const nextDeptList = [...deptList]
    const targetDept = { ...nextDeptList[deptIdx] }
    const currentSubs = targetDept.subDepartments || []

    const maxNum = currentSubs.reduce((max, item) => {
      const n = parseInt(item.xh || item.id.slice(-4), 10)
      return isNaN(n) ? max : Math.max(max, n)
    }, 0)
    const nextXh = String(maxNum + 1).padStart(4, '0')
    const nextId = `${targetDept.id}${nextXh}`

    const newSub: SubDepartmentItem = {
      id: nextId,
      xh: nextXh,
      parentDeptId: targetDept.id,
      name: '',
      status: 'enabled',
      updatedAt: today
    }

    targetDept.subDepartments = [...currentSubs, newSub]
    targetDept.updatedAt = today
    nextDeptList[deptIdx] = targetDept

    setDeptList(nextDeptList)
    setNewlyAddedSubIds((prev) => [...prev, nextId])

    // 自动跳转到细分科室最后一页
    const nextTotalCount = (targetDept.subDepartments || []).length
    const nextTotalPages = Math.ceil(nextTotalCount / subDeptPageSize)
    setSubDeptPage(nextTotalPages)
  }

  const handleDeleteSingleSub = (subId: string, subName: string): void => {
    if (!activeDrilldownDept) return
    setConfirmModal({
      isOpen: true,
      title: '删除细分科室确认',
      message: `确定要删除细分科室【${subName || subId}】（ID: ${subId}）吗？`,
      confirmText: '确认删除',
      cancelText: '取消',
      type: 'danger',
      onConfirm: async () => {
        closeConfirmModal()
        const today = getTodayString()
        const deptIdx = deptList.findIndex((d) => d.id === activeDrilldownDept.id)
        if (deptIdx === -1) return

        const nextDeptList = [...deptList]
        const targetDept = { ...nextDeptList[deptIdx] }
        targetDept.subDepartments = (targetDept.subDepartments || []).filter((s) => s.id !== subId)
        targetDept.updatedAt = today
        nextDeptList[deptIdx] = targetDept

        setNewlyAddedSubIds((prev) => prev.filter((id) => id !== subId))
        setSelectedSubIds((prev) => prev.filter((id) => id !== subId))
        await persistDeleteDeptList(nextDeptList)
      }
    })
  }

  const handleDeleteSelectedSubs = (): void => {
    if (!activeDrilldownDept) return
    if (selectedSubIds.length === 0) {
      showAlert('请先在表格左侧勾选需要批量删除的细分科室。', '操作提示', 'info')
      return
    }
    const count = selectedSubIds.length
    setConfirmModal({
      isOpen: true,
      title: '批量删除细分科室确认',
      message: `确定要删除选中的 ${count} 个细分科室吗？`,
      confirmText: `确认删除 (${count})`,
      cancelText: '取消',
      type: 'danger',
      onConfirm: async () => {
        closeConfirmModal()
        const today = getTodayString()
        const deptIdx = deptList.findIndex((d) => d.id === activeDrilldownDept.id)
        if (deptIdx === -1) return

        const nextDeptList = [...deptList]
        const targetDept = { ...nextDeptList[deptIdx] }
        targetDept.subDepartments = (targetDept.subDepartments || []).filter(
          (s) => !selectedSubIds.includes(s.id)
        )
        targetDept.updatedAt = today
        nextDeptList[deptIdx] = targetDept

        setNewlyAddedSubIds((prev) => prev.filter((id) => !selectedSubIds.includes(id)))
        setSelectedSubIds([])
        await persistDeleteDeptList(nextDeptList)
      }
    })
  }

  const handleQuerySubDepts = (): void => {
    setAppliedSubSearchName(subSearchNameDraft)
    setAppliedSubSearchStatus(subSearchStatusDraft)
    setSelectedSubIds([])
    setSubDeptPage(1)
  }

  // ─── 3. 校验并保存至数据库 (POST /api/v1/departments/save) ───
  const handleSaveToDatabase = async (): Promise<void> => {
    // 校验一级科室 ID 唯一性与非空
    const deptIdSet = new Set<string>()
    for (const d of deptList) {
      const dId = d.id.trim()
      if (!dId) {
        showAlert(`一级科室【${d.name || '未命名'}】的 ID 不能为空，请输入 4 位科室编码。`, '校验未通过', 'warning')
        return
      }
      if (deptIdSet.has(dId)) {
        showAlert(`保存失败：一级科室 ID【${dId}】重复，系统中不允许存在相同的科室编码！`, '校验未通过', 'error')
        return
      }
      deptIdSet.add(dId)

      if (!d.name.trim()) {
        showAlert(`保存失败：一级科室【ID: ${dId}】的名称不能为空，请输入科室名称。`, '校验未通过', 'warning')
        return
      }

      // 检查该一级科室下的细分科室 xh 唯一性与非空
      const subXhSet = new Set<string>()
      for (const sub of d.subDepartments || []) {
        const xh = (sub.xh || sub.id.slice(-4)).trim()
        if (!xh) {
          showAlert(`一级科室【${d.name}】下的细分科室【${sub.name || '未命名'}】ID 不能为空。`, '校验未通过', 'warning')
          return
        }
        if (subXhSet.has(xh)) {
          showAlert(`保存失败：一级科室【${d.name}】下存在重复的细分科室 ID【${xh}】（科室名称：${sub.name}），请修改为唯一 ID！`, '校验未通过', 'error')
          return
        }
        subXhSet.add(xh)

        if (!sub.name.trim()) {
          showAlert(`保存失败：一级科室【${d.name}】下的细分科室【ID: ${xh}】名称不能为空，请输入细分科室名称。`, '校验未通过', 'warning')
          return
        }
      }
    }

    setSaving(true)
    try {
      await saveDepartments(deptList)
      setSavedDeptSnapshot(JSON.parse(JSON.stringify(deptList)))
      setNewlyAddedDeptIds([])
      setNewlyAddedSubIds([])
      showAlert('保存成功', '提示', 'success')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showAlert(`保存失败：${message}`, '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  // ─── 4. 数据过滤与分页计算 ───
  // 一级科室
  const filteredDepts = deptList.filter((d) => {
    const matchKeyword =
      !appliedSearchQuery.trim() ||
      d.name.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase()) ||
      d.desc.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase()) ||
      d.id.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase())
    const matchStatus =
      appliedSearchStatus === 'all' || d.status === appliedSearchStatus
    return matchKeyword && matchStatus
  })

  const totalDeptCount = filteredDepts.length
  const totalDeptPages = Math.max(1, Math.ceil(totalDeptCount / deptPageSize))
  const currentDeptPage = Math.min(Math.max(1, deptPage), totalDeptPages)
  const pagedDepts = filteredDepts.slice(
    (currentDeptPage - 1) * deptPageSize,
    currentDeptPage * deptPageSize
  )

  const isAllCurrentPageDeptsSelected =
    pagedDepts.length > 0 && pagedDepts.every((d) => selectedDeptIds.includes(d.id))

  // 细分科室
  const allFilteredSubDepts = (activeDrilldownDept?.subDepartments || []).filter((s) => {
    const matchName =
      !appliedSubSearchName.trim() ||
      s.name.toLowerCase().includes(appliedSubSearchName.trim().toLowerCase()) ||
      (s.xh || s.id).toLowerCase().includes(appliedSubSearchName.trim().toLowerCase())
    const matchStatus =
      appliedSubSearchStatus === 'all' || s.status === appliedSubSearchStatus
    return matchName && matchStatus
  })

  const totalSubCount = allFilteredSubDepts.length
  const totalSubPages = Math.max(1, Math.ceil(totalSubCount / subDeptPageSize))
  const currentSubPage = Math.min(Math.max(1, subDeptPage), totalSubPages)
  const pagedSubDepts = allFilteredSubDepts.slice(
    (currentSubPage - 1) * subDeptPageSize,
    currentSubPage * subDeptPageSize
  )

  const isAllSubsSelected =
    pagedSubDepts.length > 0 &&
    pagedSubDepts.every((s) => selectedSubIds.includes(s.id))

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-surface-bg">
      {/* ─── 统一显式操作提示对话框 Modal ─── */}
      {alertModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl shadow-2xl border border-border-subtle max-w-md w-full overflow-hidden animate-in zoom-in-95 duration-150">
            <div className="p-6 space-y-4">
              <div className="flex items-start gap-3.5">
                <div
                  className={
                    'w-11 h-11 rounded-xl flex items-center justify-center shrink-0 border ' +
                    (alertModal.type === 'error'
                      ? 'bg-red-50 text-error border-red-200'
                      : alertModal.type === 'warning'
                        ? 'bg-amber-50 text-amber-600 border-amber-200'
                        : alertModal.type === 'success'
                          ? 'bg-emerald-50 text-action-green border-emerald-200'
                          : 'bg-primary/10 text-primary border-primary/20')
                  }
                >
                  <span className="material-symbols-outlined text-[26px]">
                    {alertModal.type === 'error'
                      ? 'error'
                      : alertModal.type === 'warning'
                        ? 'warning'
                        : alertModal.type === 'success'
                          ? 'check_circle'
                          : 'info'}
                  </span>
                </div>
                <div className="space-y-1.5 flex-1 min-w-0">
                  <h3 className="text-h3-title text-text-main font-bold">
                    {alertModal.title}
                  </h3>
                  <p className="text-body-sm text-text-muted leading-relaxed whitespace-pre-wrap break-words">
                    {alertModal.message}
                  </p>
                </div>
              </div>
            </div>

            <div className="px-6 py-3.5 bg-surface-container-low/50 border-t border-border-subtle flex items-center justify-end">
              <button
                type="button"
                autoFocus
                onClick={() => {
                  closeAlertModal()
                  if (alertModal.onClose) alertModal.onClose()
                }}
                className={
                  'px-5 py-2 rounded-lg text-body-sm font-semibold text-white shadow-xs transition-all cursor-pointer ' +
                  (alertModal.type === 'error'
                    ? 'bg-error hover:bg-red-600'
                    : alertModal.type === 'warning'
                      ? 'bg-amber-600 hover:bg-amber-700'
                      : alertModal.type === 'success'
                        ? 'bg-action-green hover:bg-emerald-600'
                        : 'bg-primary hover:bg-primary/90')
                }
              >
                {alertModal.confirmText || '我知道了'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── 二次确认通用对话框 Modal ─── */}
      {confirmModal.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-xs p-4 animate-in fade-in duration-150">
          <div className="bg-white rounded-2xl shadow-2xl border border-border-subtle max-w-md w-full overflow-hidden animate-in zoom-in-95 duration-150">
            <div className="p-6 space-y-4">
              <div className="flex items-start gap-3.5">
                <div
                  className={
                    'w-10 h-10 rounded-full flex items-center justify-center shrink-0 ' +
                    (confirmModal.type === 'danger'
                      ? 'bg-red-50 text-error'
                      : 'bg-primary/10 text-primary')
                  }
                >
                  <span className="material-symbols-outlined text-[24px]">
                    {confirmModal.type === 'danger' ? 'warning' : 'help'}
                  </span>
                </div>
                <div className="space-y-1 flex-1 min-w-0">
                  <h3 className="text-h3-title text-text-main font-bold">
                    {confirmModal.title}
                  </h3>
                  <p className="text-body-sm text-text-muted leading-relaxed whitespace-pre-wrap break-words">
                    {confirmModal.message}
                  </p>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 bg-surface-container-low/50 border-t border-border-subtle flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={closeConfirmModal}
                className="px-4 py-2 rounded-lg text-body-sm font-medium text-text-muted hover:text-text-main hover:bg-surface-container-low transition-colors cursor-pointer"
              >
                {confirmModal.cancelText || '取消'}
              </button>
              <button
                type="button"
                onClick={confirmModal.onConfirm}
                className={
                  'px-4 py-2 rounded-lg text-body-sm font-semibold text-white shadow-xs transition-colors cursor-pointer ' +
                  (confirmModal.type === 'danger'
                    ? 'bg-error hover:bg-red-600'
                    : 'bg-primary hover:bg-primary/90')
                }
              >
                {confirmModal.confirmText || '确定'}
              </button>
            </div>
          </div>
        </div>
      )}

      {drilldownDeptId && activeDrilldownDept ? (
        /* ══════════════════════════════════════════════════════════
           视图 A: 细分科室下钻填报表 (f_hy_xfks)
           ══════════════════════════════════════════════════════════ */
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4 animate-in fade-in duration-150">
          {/* 顶栏卡片 - 与对内科室管理完全统一规范 */}
          <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setDrilldownDeptId(null)}
                className="text-primary hover:text-primary-container font-medium flex items-center gap-0.5 cursor-pointer transition-colors text-body-sm"
              >
                <span className="material-symbols-outlined text-[18px]">arrow_back</span>
                对内科室管理
              </button>
              <span className="material-symbols-outlined text-[16px] text-outline">chevron_right</span>
              <h1 className="text-h2-header text-text-main font-bold">
                【{activeDrilldownDept.name || activeDrilldownDept.id}】细分科室
              </h1>
              <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
                共 {activeDrilldownDept.subDepartments?.length || 0} 个细分
              </span>
            </div>

            <div className="flex items-center flex-wrap gap-3">
              {/* 细分名称/ID搜索输入与状态与查询 */}
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
                    placeholder="搜索细分科室或ID…"
                    value={subSearchNameDraft}
                    onChange={(e) => setSubSearchNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleQuerySubDepts()
                    }}
                    className="pl-9 pr-8 py-1.5 bg-white border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary w-48 transition-all"
                  />
                  {subSearchNameDraft && (
                    <button
                      type="button"
                      onClick={() => {
                        setSubSearchNameDraft('')
                        setAppliedSubSearchName('')
                        setSubDeptPage(1)
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
                    <option value="disabled">禁用</option>
                  </select>
                </div>

                <button
                  type="button"
                  onClick={handleQuerySubDepts}
                  className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[16px]">search</span>
                  查询
                </button>
              </div>

              {/* 保存按钮 */}
              <button
                type="button"
                onClick={handleSaveToDatabase}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-all shadow-xs cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">save</span>
                {saving ? '保存中…' : '保存'}
              </button>

              {/* 删除选中 */}
              <button
                type="button"
                onClick={handleDeleteSelectedSubs}
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

              {/* 新增细分 */}
              <button
                type="button"
                onClick={handleAddNewSubDepartment}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                新增细分
              </button>
            </div>
          </div>

          {/* 细分表格卡片 */}
          <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto">
              <table className="min-w-[800px] w-full text-left border-collapse">
                <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
                  <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                    <th className="py-3 px-4 w-12 min-w-[48px] text-center">
                      <input
                        type="checkbox"
                        checked={isAllSubsSelected}
                        onChange={() => {
                          if (isAllSubsSelected) {
                            const pageIds = pagedSubDepts.map((s) => s.id)
                            setSelectedSubIds((prev) => prev.filter((id) => !pageIds.includes(id)))
                          } else {
                            const pageIds = pagedSubDepts.map((s) => s.id)
                            setSelectedSubIds((prev) => Array.from(new Set([...prev, ...pageIds])))
                          }
                        }}
                        className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                      />
                    </th>
                    <th className="py-3 px-4 w-24 min-w-[90px] text-center">ID</th>
                    <th className="py-3 px-4 min-w-[280px]">科室细分名称</th>
                    <th className="py-3 px-4 w-32 min-w-[110px] text-center">状态</th>
                    <th className="py-3 px-4 w-44 min-w-[140px] text-center">更新时间</th>
                    <th className="py-3 px-4 w-16 min-w-[60px] text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle text-body-sm">
                  {pagedSubDepts.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-16 text-center text-text-muted">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <span className="material-symbols-outlined text-[36px] text-outline">
                            search_off
                          </span>
                          <span>暂无符合条件的细分科室</span>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    pagedSubDepts.map((subItem, sIdx) => {
                      const originalSubIndex = (
                        activeDrilldownDept.subDepartments || []
                      ).findIndex((s) => s.id === subItem.id)
                      const isSubChecked = selectedSubIds.includes(subItem.id)
                      const isSubNew = newlyAddedSubIds.includes(subItem.id)

                      // 查找快照对比是否编辑
                      const savedParent = savedDeptSnapshot.find((s) => s.id === activeDrilldownDept.id)
                      const savedSub =
                        (savedParent?.subDepartments || []).find((s) => s.id === subItem.id) ||
                        (savedParent?.subDepartments || [])[originalSubIndex]

                      const isSubNameEdited = Boolean(savedSub && savedSub.name !== subItem.name)
                      const isSubStatusEdited = Boolean(savedSub && savedSub.status !== subItem.status)
                      const isSubXhEdited = Boolean(
                        savedSub &&
                          ((savedSub.xh || savedSub.id.slice(-4)) !== (subItem.xh || subItem.id.slice(-4)) ||
                            savedSub.id !== subItem.id)
                      )
                      const isSubEdited =
                        !isSubNew && Boolean(savedSub && (isSubNameEdited || isSubStatusEdited || isSubXhEdited))

                      const subRowBgClass = isSubChecked
                        ? 'bg-primary/10 border-l-4 border-l-primary hover:bg-primary/15'
                        : isSubNew
                          ? 'bg-emerald-50/90 hover:bg-emerald-100/80 border-l-4 border-l-action-green'
                          : isSubEdited
                            ? 'bg-amber-50/90 hover:bg-amber-100/80 border-l-4 border-l-amber-500'
                            : 'hover:bg-surface-container-low/50 border-l-4 border-l-transparent'

                      return (
                        <tr
                          key={subItem.id + '_' + sIdx}
                          className={'transition-colors ' + subRowBgClass}
                        >
                          <td className="py-3 px-4 text-center">
                            <input
                              type="checkbox"
                              checked={isSubChecked}
                              onChange={() => {
                                setSelectedSubIds((prev) =>
                                  prev.includes(subItem.id)
                                    ? prev.filter((x) => x !== subItem.id)
                                    : [...prev, subItem.id]
                                )
                              }}
                              className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                            />
                          </td>

                          <td className="py-2.5 px-3 font-mono-data text-center whitespace-nowrap">
                            <div className="flex items-center justify-center gap-1.5">
                              {(() => {
                                const currentXh = (subItem.xh || subItem.id.slice(-4)).trim()
                                const isDuplicate =
                                  (activeDrilldownDept?.subDepartments || []).filter(
                                    (s) => (s.xh || s.id.slice(-4)).trim() === currentXh
                                  ).length > 1
                                return (
                                  <input
                                    type="text"
                                    value={subItem.xh || subItem.id.slice(-4)}
                                    onChange={(e) =>
                                      handleSubFieldChange(originalSubIndex, 'xh', e.target.value)
                                    }
                                    title={
                                      isDuplicate
                                        ? `ID【${currentXh}】在本科室下重复，请修改为唯一ID`
                                        : `物理主键: ${subItem.id} (上级科室 ${subItem.parentDeptId} + 序号 ${subItem.xh})`
                                    }
                                    className={
                                      'w-16 px-2 py-1 text-center font-mono-data text-body-sm font-semibold rounded-md transition-all focus:outline-none ' +
                                      (isDuplicate
                                        ? 'text-error bg-red-50/60 border border-error focus:border-error focus:ring-1 focus:ring-error'
                                        : isSubXhEdited
                                          ? 'text-amber-950 bg-amber-100/90 border border-amber-400 font-bold focus:bg-white focus:border-amber-500 focus:ring-1 focus:ring-amber-500 shadow-2xs'
                                          : isSubNew
                                            ? 'text-emerald-950 bg-emerald-50/90 border border-emerald-300 focus:bg-white focus:border-action-green focus:ring-1 focus:ring-action-green shadow-2xs'
                                            : isSubEdited
                                              ? 'text-text-main bg-amber-50/60 border border-amber-200 focus:bg-white focus:border-amber-500 focus:ring-1 focus:ring-amber-500 shadow-2xs'
                                              : 'text-text-main bg-white border border-border-subtle hover:border-primary/50 focus:border-primary focus:ring-1 focus:ring-primary shadow-2xs')
                                    }
                                  />
                                )
                              })()}
                              {isSubNew && (
                                <span className="px-1.5 py-0.5 text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 rounded shrink-0">
                                  新增
                                </span>
                              )}
                              {isSubEdited && (
                                <span className="px-1.5 py-0.5 text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300 rounded shrink-0">
                                  已修改
                                </span>
                              )}
                            </div>
                          </td>

                          <td className="py-2.5 px-3">
                            <input
                              type="text"
                              value={subItem.name}
                              onChange={(e) =>
                                handleSubFieldChange(originalSubIndex, 'name', e.target.value)
                              }
                              placeholder="输入细分科室名称…"
                              className={
                                'w-full px-3 py-1.5 text-body-sm font-medium rounded-md transition-all focus:outline-none focus:ring-1 shadow-2xs ' +
                                (isSubNameEdited
                                  ? 'text-amber-950 bg-amber-100/90 border border-amber-400 font-semibold focus:bg-white focus:border-amber-500 focus:ring-amber-500'
                                  : isSubNew
                                    ? 'text-text-main bg-emerald-50/70 border border-emerald-300 focus:bg-white focus:border-action-green focus:ring-action-green'
                                    : isSubEdited
                                      ? 'text-text-main bg-amber-50/50 border border-amber-200 focus:bg-white focus:border-amber-500 focus:ring-amber-500'
                                      : 'text-text-main bg-white border border-border-subtle hover:border-primary/50 focus:border-primary focus:ring-primary')
                              }
                            />
                          </td>

                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <select
                              value={subItem.status}
                              onChange={(e) =>
                                handleSubFieldChange(
                                  originalSubIndex,
                                  'status',
                                  e.target.value
                                )
                              }
                              className={
                                'px-3 py-1.5 border rounded-md text-body-sm font-medium focus:outline-none transition-all cursor-pointer whitespace-nowrap shadow-2xs ' +
                                (isSubStatusEdited ? 'ring-2 ring-amber-400 border-amber-400 ' : '') +
                                (subItem.status === 'enabled'
                                  ? 'border-emerald-200 text-action-green bg-emerald-50/60 hover:border-action-green'
                                  : 'border-border-subtle text-text-muted bg-surface-container-low hover:border-outline')
                              }
                            >
                              <option value="enabled">● 启用</option>
                              <option value="disabled">○ 禁用</option>
                            </select>
                          </td>

                          <td className="py-3 px-6 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                            {subItem.updatedAt}
                          </td>

                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleDeleteSingleSub(subItem.id, subItem.name)}
                              className="inline-flex items-center justify-center p-1.5 rounded-md text-outline hover:text-error hover:bg-red-50 transition-colors cursor-pointer"
                              title="删除该细分科室"
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

            {/* 细分科室分页栏 */}
            <div className="px-5 py-3.5 bg-white border-t border-border-subtle flex flex-wrap items-center justify-between gap-4 text-body-sm text-text-muted shrink-0 select-none">
              <div className="flex items-center gap-3">
                <span>
                  共 <strong className="text-text-main font-semibold">{totalSubCount}</strong> 条
                </span>
                <span className="text-outline">|</span>
                <span>
                  第 <strong className="text-text-main font-semibold">{totalSubCount > 0 ? (currentSubPage - 1) * subDeptPageSize + 1 : 0}</strong> -{' '}
                  <strong className="text-text-main font-semibold">{Math.min(currentSubPage * subDeptPageSize, totalSubCount)}</strong> 条
                </span>
              </div>

              <div className="flex items-center flex-wrap gap-3">
                {/* 每页条数下拉选择 */}
                <div className="flex items-center gap-1.5">
                  <select
                    value={subDeptPageSize}
                    onChange={(e) => {
                      setSubDeptPageSize(Number(e.target.value))
                      setSubDeptPage(1)
                    }}
                    className="px-2.5 py-1.5 bg-white border border-border-subtle rounded-lg text-body-sm text-text-main hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer transition-all"
                  >
                    <option value={10}>10 条/页</option>
                    <option value={20}>20 条/页</option>
                    <option value={50}>50 条/页</option>
                    <option value={100}>100 条/页</option>
                  </select>
                </div>

                {/* 翻页按钮组 */}
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={currentSubPage <= 1}
                    onClick={() => setSubDeptPage(1)}
                    className="p-1.5 rounded-lg border border-border-subtle bg-white hover:bg-surface-container-low text-text-main disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center justify-center"
                    title="第一页"
                  >
                    <span className="material-symbols-outlined text-[18px]">first_page</span>
                  </button>

                  <button
                    type="button"
                    disabled={currentSubPage <= 1}
                    onClick={() => setSubDeptPage((p) => Math.max(1, p - 1))}
                    className="p-1.5 rounded-lg border border-border-subtle bg-white hover:bg-surface-container-low text-text-main disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center justify-center"
                    title="上一页"
                  >
                    <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                  </button>

                  <div className="flex items-center gap-1 mx-1">
                    {Array.from({ length: totalSubPages }, (_, i) => i + 1)
                      .filter((p) => {
                        if (totalSubPages <= 7) return true
                        if (p === 1 || p === totalSubPages) return true
                        return Math.abs(p - currentSubPage) <= 1
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
                            <span key={`sub-ellipsis-${pIdx}`} className="px-1.5 text-text-muted select-none">
                              ...
                            </span>
                          )
                        }
                        const pNum = Number(pageItem)
                        const isCurrent = pNum === currentSubPage
                        return (
                          <button
                            key={`sub-page-${pNum}`}
                            type="button"
                            onClick={() => setSubDeptPage(pNum)}
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

                  <button
                    type="button"
                    disabled={currentSubPage >= totalSubPages}
                    onClick={() => setSubDeptPage((p) => Math.min(totalSubPages, p + 1))}
                    className="p-1.5 rounded-lg border border-border-subtle bg-white hover:bg-surface-container-low text-text-main disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center justify-center"
                    title="下一页"
                  >
                    <span className="material-symbols-outlined text-[18px]">chevron_right</span>
                  </button>

                  <button
                    type="button"
                    disabled={currentSubPage >= totalSubPages}
                    onClick={() => setSubDeptPage(totalSubPages)}
                    className="p-1.5 rounded-lg border border-border-subtle bg-white hover:bg-surface-container-low text-text-main disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center justify-center"
                    title="最后一页"
                  >
                    <span className="material-symbols-outlined text-[18px]">last_page</span>
                  </button>
                </div>

                {/* 跳页输入 */}
                <div className="flex items-center gap-1.5 text-body-sm">
                  <span>前往</span>
                  <input
                    type="number"
                    min={1}
                    max={totalSubPages}
                    value={subDeptJumpPage}
                    onChange={(e) => setSubDeptJumpPage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const target = parseInt(subDeptJumpPage, 10)
                        if (!isNaN(target) && target >= 1 && target <= totalSubPages) {
                          setSubDeptPage(target)
                          setSubDeptJumpPage('')
                        }
                      }
                    }}
                    placeholder={String(currentSubPage)}
                    className="w-14 px-2 py-1 bg-white border border-border-subtle rounded-lg text-center text-body-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  />
                  <span>页</span>
                  <button
                    type="button"
                    onClick={() => {
                      const target = parseInt(subDeptJumpPage, 10)
                      if (!isNaN(target) && target >= 1 && target <= totalSubPages) {
                        setSubDeptPage(target)
                        setSubDeptJumpPage('')
                      }
                    }}
                    className="px-2.5 py-1 rounded-lg border border-border-subtle bg-white hover:bg-surface-container-low text-text-main text-body-sm font-medium transition-colors cursor-pointer"
                  >
                    跳转
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* ══════════════════════════════════════════════════════════
           视图 B: 一级科室主表格 (f_hy_kswh)
           ══════════════════════════════════════════════════════════ */
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4 animate-in fade-in duration-150">
          {/* 顶栏卡片 */}
          <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
            <div className="flex items-center gap-3">
              <h1 className="text-h2-header text-text-main font-bold">对内科室管理</h1>
              <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
                共 {deptList.length} 个科室大类
              </span>
            </div>

            <div className="flex items-center flex-wrap gap-3">
              {/* 搜索输入与状态下拉与查询按钮 */}
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
                    placeholder="搜索科室、描述或ID…"
                    value={searchDraft}
                    onChange={(e) => setSearchDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleQueryMainDepts()
                    }}
                    className="pl-9 pr-8 py-1.5 bg-white border border-border-subtle rounded-lg text-body-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary w-52 transition-all"
                  />
                  {searchDraft && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchDraft('')
                        setAppliedSearchQuery('')
                        setDeptPage(1)
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
                    <option value="disabled">禁用</option>
                  </select>
                </div>

                <button
                  type="button"
                  onClick={handleQueryMainDepts}
                  className="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[16px]">search</span>
                  查询
                </button>
              </div>

              {/* 保存按钮 */}
              <button
                type="button"
                onClick={handleSaveToDatabase}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-semibold hover:bg-primary/90 disabled:opacity-50 transition-all shadow-xs cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">save</span>
                {saving ? '保存中…' : '保存'}
              </button>

              {/* 删除选中 */}
              <button
                type="button"
                onClick={handleDeleteSelectedDepts}
                disabled={selectedDeptIds.length === 0}
                className={
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
                  (selectedDeptIds.length > 0
                    ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                    : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
                }
              >
                <span className="material-symbols-outlined text-[18px]">delete</span>
                删除 {selectedDeptIds.length > 0 ? `(${selectedDeptIds.length})` : ''}
              </button>

              {/* 新增科室 */}
              <button
                type="button"
                onClick={handleAddNewDepartment}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                新增科室
              </button>
            </div>
          </div>

          {/* 表格卡片 */}
          <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto">
              <table className="min-w-[1100px] w-full text-left border-collapse">
                <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
                  <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                    <th className="py-3 px-4 w-12 min-w-[48px] text-center">
                      <input
                        type="checkbox"
                        checked={isAllCurrentPageDeptsSelected}
                        onChange={() => {
                          if (isAllCurrentPageDeptsSelected) {
                            const pageIds = pagedDepts.map((d) => d.id)
                            setSelectedDeptIds((prev) => prev.filter((id) => !pageIds.includes(id)))
                          } else {
                            const pageIds = pagedDepts.map((d) => d.id)
                            setSelectedDeptIds((prev) => Array.from(new Set([...prev, ...pageIds])))
                          }
                        }}
                        className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                      />
                    </th>
                    <th className="py-3 px-4 w-24 min-w-[90px] text-center">ID</th>
                    <th className="py-3 px-4 w-28 min-w-[110px] text-center">操作</th>
                    <th className="py-3 px-4 w-60 min-w-[200px]">科室大类名称</th>
                    <th className="py-3 px-4 min-w-[240px]">描述</th>
                    <th className="py-3 px-4 w-32 min-w-[110px] text-center">状态</th>
                    <th className="py-3 px-4 w-40 min-w-[140px] text-center">创建时间</th>
                    <th className="py-3 px-4 w-40 min-w-[140px] text-center">更新时间</th>
                    <th className="py-3 px-4 w-16 min-w-[60px] text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle text-body-sm">
                  {loading ? (
                    <tr>
                      <td colSpan={9} className="py-16 text-center text-text-muted">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <span className="material-symbols-outlined text-[36px] text-primary animate-spin">
                            progress_activity
                          </span>
                          <span>正在从数据库加载科室数据…</span>
                        </div>
                      </td>
                    </tr>
                  ) : filteredDepts.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-16 text-center text-text-muted">
                        <div className="flex flex-col items-center justify-center gap-2">
                          <span className="material-symbols-outlined text-[36px] text-outline">
                            search_off
                          </span>
                          <span>未找到匹配的科室大类</span>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    pagedDepts.map((item, idx) => {
                      const originalIndex = deptList.findIndex((d) => d.id === item.id)
                      const isChecked = selectedDeptIds.includes(item.id)
                      const isNew = newlyAddedDeptIds.includes(item.id)

                      const savedItem =
                        savedDeptSnapshot.find((s) => s.id === item.id) ||
                        savedDeptSnapshot[originalIndex]

                      const isIdEdited = Boolean(savedItem && savedItem.id !== item.id)
                      const isNameEdited = Boolean(savedItem && savedItem.name !== item.name)
                      const isDescEdited = Boolean(savedItem && savedItem.desc !== item.desc)
                      const isStatusEdited = Boolean(savedItem && savedItem.status !== item.status)

                      const isEdited =
                        !isNew &&
                        Boolean(savedItem && (isIdEdited || isNameEdited || isDescEdited || isStatusEdited))

                      const rowBgClass = isChecked
                        ? 'bg-primary/10 border-l-4 border-l-primary hover:bg-primary/15'
                        : isNew
                          ? 'bg-emerald-50/90 hover:bg-emerald-100/80 border-l-4 border-l-action-green'
                          : isEdited
                            ? 'bg-amber-50/90 hover:bg-amber-100/80 border-l-4 border-l-amber-500'
                            : 'hover:bg-surface-container-low/50 border-l-4 border-l-transparent'

                      return (
                        <tr
                          key={item.id + '_' + idx}
                          className={'transition-colors ' + rowBgClass}
                        >
                          {/* 复选框 */}
                          <td className="py-3 px-4 text-center">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => {
                                setSelectedDeptIds((prev) =>
                                  prev.includes(item.id)
                                    ? prev.filter((x) => x !== item.id)
                                    : [...prev, item.id]
                                )
                              }}
                              className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                            />
                          </td>

                          {/* ID 显式输入框 */}
                          <td className="py-2.5 px-3 font-mono-data text-center whitespace-nowrap">
                            <div className="flex items-center justify-center gap-1.5">
                              {(() => {
                                const hasChildren = (item.subDepartments || []).length > 0
                                const isDuplicate =
                                  deptList.filter((d) => d.id.trim() === item.id.trim()).length > 1
                                return (
                                  <input
                                    type="text"
                                    value={item.id}
                                    disabled={hasChildren}
                                    readOnly={hasChildren}
                                    onChange={(e) =>
                                      handleDeptFieldChange(originalIndex, 'id', e.target.value)
                                    }
                                    title={
                                      hasChildren
                                        ? '该科室已存在下级细分科室，不允许修改ID'
                                        : isDuplicate
                                          ? '该一级科室ID重复，请修改为唯一ID'
                                          : '输入一级科室ID（4位）'
                                    }
                                    className={
                                      'w-16 px-2 py-1 text-center font-mono-data text-body-sm font-semibold rounded-md transition-all focus:outline-none ' +
                                      (hasChildren
                                        ? 'text-text-muted bg-surface-container-low/80 border border-border-subtle cursor-not-allowed opacity-75 select-none'
                                        : isDuplicate
                                          ? 'text-error bg-red-50/60 border border-error focus:border-error focus:ring-1 focus:ring-error'
                                          : isIdEdited
                                            ? 'text-amber-950 bg-amber-100/90 border border-amber-400 font-bold focus:bg-white focus:border-amber-500 focus:ring-1 focus:ring-amber-500 shadow-2xs'
                                            : isNew
                                              ? 'text-emerald-950 bg-emerald-50/90 border border-emerald-300 focus:bg-white focus:border-action-green focus:ring-1 focus:ring-action-green shadow-2xs'
                                              : isEdited
                                                ? 'text-text-main bg-amber-50/60 border border-amber-200 focus:bg-white focus:border-amber-500 focus:ring-1 focus:ring-amber-500 shadow-2xs'
                                                : 'text-text-main bg-white border border-border-subtle hover:border-primary/50 focus:border-primary focus:ring-1 focus:ring-primary shadow-2xs')
                                    }
                                  />
                                )
                              })()}
                              {isNew && (
                                <span className="px-1.5 py-0.5 text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 rounded shrink-0">
                                  新增
                                </span>
                              )}
                              {isEdited && (
                                <span className="px-1.5 py-0.5 text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300 rounded shrink-0">
                                  已修改
                                </span>
                              )}
                            </div>
                          </td>

                          {/* 细分科室操作 */}
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => {
                                setDrilldownDeptId(item.id)
                                setSubSearchNameDraft('')
                                setSubSearchStatusDraft('all')
                                setAppliedSubSearchName('')
                                setAppliedSubSearchStatus('all')
                                setSelectedSubIds([])
                                setSubDeptPage(1)
                              }}
                              className="inline-flex items-center gap-0.5 px-2.5 py-1 rounded-md text-primary bg-primary/10 hover:bg-primary hover:text-white border border-primary/20 text-[13px] font-medium transition-all cursor-pointer group shadow-2xs"
                              title="点击下钻查看并填报细分科室"
                            >
                              <span>细分科室</span>
                              <span className="material-symbols-outlined text-[15px] transition-transform group-hover:translate-x-0.5">
                                chevron_right
                              </span>
                            </button>
                          </td>

                          {/* 科室大类名称 显式输入框 */}
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <input
                              type="text"
                              value={item.name}
                              onChange={(e) =>
                                handleDeptFieldChange(originalIndex, 'name', e.target.value)
                              }
                              placeholder="输入科室大类名称…"
                              className={
                                'w-full px-3 py-1.5 text-body-sm font-medium rounded-md transition-all focus:outline-none focus:ring-1 shadow-2xs ' +
                                (isNameEdited
                                  ? 'text-amber-950 bg-amber-100/90 border border-amber-400 font-semibold focus:bg-white focus:border-amber-500 focus:ring-amber-500'
                                  : isNew
                                    ? 'text-text-main bg-emerald-50/70 border border-emerald-300 focus:bg-white focus:border-action-green focus:ring-action-green'
                                    : isEdited
                                      ? 'text-text-main bg-amber-50/50 border border-amber-200 focus:bg-white focus:border-amber-500 focus:ring-amber-500'
                                      : 'text-text-main bg-white border border-border-subtle hover:border-primary/50 focus:border-primary focus:ring-primary')
                              }
                            />
                          </td>

                          {/* 描述 显式输入框 */}
                          <td className="py-2.5 px-3">
                            <input
                              type="text"
                              value={item.desc}
                              onChange={(e) =>
                                handleDeptFieldChange(originalIndex, 'desc', e.target.value)
                              }
                              placeholder="输入学科体系描述…"
                              className={
                                'w-full px-3 py-1.5 text-body-sm rounded-md transition-all focus:outline-none focus:ring-1 shadow-2xs ' +
                                (isDescEdited
                                  ? 'text-amber-950 bg-amber-100/90 border border-amber-400 font-medium focus:bg-white focus:border-amber-500 focus:ring-amber-500'
                                  : isNew
                                    ? 'text-text-main bg-emerald-50/70 border border-emerald-300 focus:bg-white focus:border-action-green focus:ring-action-green'
                                    : isEdited
                                      ? 'text-text-main bg-amber-50/50 border border-amber-200 focus:bg-white focus:border-amber-500 focus:ring-amber-500'
                                      : 'text-text-main bg-white border border-border-subtle hover:border-primary/50 focus:border-primary focus:ring-primary')
                              }
                            />
                          </td>

                          {/* 状态下拉框 */}
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <select
                              value={item.status}
                              onChange={(e) =>
                                handleDeptFieldChange(originalIndex, 'status', e.target.value)
                              }
                              className={
                                'px-3 py-1.5 border rounded-md text-body-sm font-medium focus:outline-none transition-all cursor-pointer whitespace-nowrap shadow-2xs ' +
                                (isStatusEdited ? 'ring-2 ring-amber-400 border-amber-400 ' : '') +
                                (item.status === 'enabled'
                                  ? 'border-emerald-200 text-action-green bg-emerald-50/60 hover:border-action-green'
                                  : 'border-border-subtle text-text-muted bg-surface-container-low hover:border-outline')
                              }
                            >
                              <option value="enabled">● 启用</option>
                              <option value="disabled">○ 禁用</option>
                            </select>
                          </td>

                          {/* 创建时间 */}
                          <td className="py-3 px-5 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                            {item.createdAt}
                          </td>

                          {/* 更新时间 */}
                          <td className="py-3 px-5 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                            {item.updatedAt}
                          </td>

                          {/* 行删除 */}
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleDeleteSingleDept(item.id, item.name)}
                              className="inline-flex items-center justify-center p-1.5 rounded-md text-outline hover:text-error hover:bg-red-50 transition-colors cursor-pointer"
                              title="删除该科室"
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

            {/* 底部完整分页栏 */}
            <div className="px-5 py-3.5 bg-white border-t border-border-subtle flex flex-wrap items-center justify-between gap-4 text-body-sm text-text-muted shrink-0 select-none">
              <div className="flex items-center gap-3">
                <span>
                  共 <strong className="text-text-main font-semibold">{totalDeptCount}</strong> 条
                </span>
                <span className="text-outline">|</span>
                <span>
                  第 <strong className="text-text-main font-semibold">{totalDeptCount > 0 ? (currentDeptPage - 1) * deptPageSize + 1 : 0}</strong> -{' '}
                  <strong className="text-text-main font-semibold">{Math.min(currentDeptPage * deptPageSize, totalDeptCount)}</strong> 条
                </span>
              </div>

              <div className="flex items-center flex-wrap gap-3">
                {/* 每页条数下拉选择 */}
                <div className="flex items-center gap-1.5">
                  <select
                    value={deptPageSize}
                    onChange={(e) => {
                      setDeptPageSize(Number(e.target.value))
                      setDeptPage(1)
                    }}
                    className="px-2.5 py-1.5 bg-white border border-border-subtle rounded-lg text-body-sm text-text-main hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer transition-all"
                  >
                    <option value={10}>10 条/页</option>
                    <option value={20}>20 条/页</option>
                    <option value={50}>50 条/页</option>
                    <option value={100}>100 条/页</option>
                  </select>
                </div>

                {/* 翻页按钮组 */}
                <div className="flex items-center gap-1">
                  {/* 首页 */}
                  <button
                    type="button"
                    disabled={currentDeptPage <= 1}
                    onClick={() => setDeptPage(1)}
                    className="p-1.5 rounded-lg border border-border-subtle bg-white hover:bg-surface-container-low text-text-main disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center justify-center"
                    title="第一页"
                  >
                    <span className="material-symbols-outlined text-[18px]">first_page</span>
                  </button>

                  {/* 上一页 */}
                  <button
                    type="button"
                    disabled={currentDeptPage <= 1}
                    onClick={() => setDeptPage((p) => Math.max(1, p - 1))}
                    className="p-1.5 rounded-lg border border-border-subtle bg-white hover:bg-surface-container-low text-text-main disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center justify-center"
                    title="上一页"
                  >
                    <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                  </button>

                  {/* 页码序列 */}
                  <div className="flex items-center gap-1 mx-1">
                    {Array.from({ length: totalDeptPages }, (_, i) => i + 1)
                      .filter((p) => {
                        if (totalDeptPages <= 7) return true
                        if (p === 1 || p === totalDeptPages) return true
                        return Math.abs(p - currentDeptPage) <= 1
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
                            <span key={`page-ellipsis-${pIdx}`} className="px-1.5 text-text-muted select-none">
                              ...
                            </span>
                          )
                        }
                        const pNum = Number(pageItem)
                        const isCurrent = pNum === currentDeptPage
                        return (
                          <button
                            key={`dept-page-${pNum}`}
                            type="button"
                            onClick={() => setDeptPage(pNum)}
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
                    disabled={currentDeptPage >= totalDeptPages}
                    onClick={() => setDeptPage((p) => Math.min(totalDeptPages, p + 1))}
                    className="p-1.5 rounded-lg border border-border-subtle bg-white hover:bg-surface-container-low text-text-main disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center justify-center"
                    title="下一页"
                  >
                    <span className="material-symbols-outlined text-[18px]">chevron_right</span>
                  </button>

                  {/* 末页 */}
                  <button
                    type="button"
                    disabled={currentDeptPage >= totalDeptPages}
                    onClick={() => setDeptPage(totalDeptPages)}
                    className="p-1.5 rounded-lg border border-border-subtle bg-white hover:bg-surface-container-low text-text-main disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer flex items-center justify-center"
                    title="最后一页"
                  >
                    <span className="material-symbols-outlined text-[18px]">last_page</span>
                  </button>
                </div>

                {/* 跳页输入 */}
                <div className="flex items-center gap-1.5 text-body-sm">
                  <span>前往</span>
                  <input
                    type="number"
                    min={1}
                    max={totalDeptPages}
                    value={deptJumpPage}
                    onChange={(e) => setDeptJumpPage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const target = parseInt(deptJumpPage, 10)
                        if (!isNaN(target) && target >= 1 && target <= totalDeptPages) {
                          setDeptPage(target)
                          setDeptJumpPage('')
                        }
                      }
                    }}
                    placeholder={String(currentDeptPage)}
                    className="w-14 px-2 py-1 bg-white border border-border-subtle rounded-lg text-center text-body-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  />
                  <span>页</span>
                  <button
                    type="button"
                    onClick={() => {
                      const target = parseInt(deptJumpPage, 10)
                      if (!isNaN(target) && target >= 1 && target <= totalDeptPages) {
                        setDeptPage(target)
                        setDeptJumpPage('')
                      }
                    }}
                    className="px-2.5 py-1 rounded-lg border border-border-subtle bg-white hover:bg-surface-container-low text-text-main text-body-sm font-medium transition-colors cursor-pointer"
                  >
                    跳转
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
