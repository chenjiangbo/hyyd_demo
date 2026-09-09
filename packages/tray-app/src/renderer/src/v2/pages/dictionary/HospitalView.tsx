import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
  HospitalItem,
  HospitalDeptItem,
  DepartmentItem,
  RegionCityItem,
  fetchHospitals,
  saveHospitals,
  fetchDepartments,
  fetchRegions,
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

export default function HospitalView(): React.JSX.Element {
  const [hospitals, setHospitals] = useState<HospitalItem[]>([])
  const [deptList, setDeptList] = useState<DepartmentItem[]>([])
  const [regionList, setRegionList] = useState<RegionCityItem[]>([])
  const [newlyAddedHospIds, setNewlyAddedHospIds] = useState<string[]>([])
  const [newlyAddedDeptIds, setNewlyAddedDeptIds] = useState<string[]>([])

  const [loading, setLoading] = useState<boolean>(true)
  const [saving, setSaving] = useState<boolean>(false)

  const [alertModal, setAlertModal] = useState<AlertModalConfig>({
    isOpen: false,
    title: '',
    message: '',
    type: 'info'
  })

  const [drilldownHospitalId, setDrilldownHospitalId] = useState<string | null>(null)

  const [selectedHospIds, setSelectedHospIds] = useState<string[]>([])
  const [selectedDeptIds, setSelectedDeptIds] = useState<string[]>([])

  const [searchDraft, setSearchDraft] = useState('')
  const [searchStatusDraft, setSearchStatusDraft] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [appliedSearchQuery, setAppliedSearchQuery] = useState('')
  const [appliedSearchStatus, setAppliedSearchStatus] = useState<'all' | 'enabled' | 'disabled'>('all')

  const [subSearchDraft, setSubSearchDraft] = useState('')
  const [subSearchStatusDraft, setSubSearchStatusDraft] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [appliedSubSearchQuery, setAppliedSubSearchQuery] = useState('')
  const [appliedSubSearchStatus, setAppliedSubSearchStatus] = useState<'all' | 'enabled' | 'disabled'>('all')

  const [hospPage, setHospPage] = useState<number>(1)
  const [hospPageSize, setHospPageSize] = useState<number>(10)

  const [deptPage, setDeptPage] = useState<number>(1)
  const [deptPageSize, setDeptPageSize] = useState<number>(10)

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
      const [hospData, deptData, regData] = await Promise.all([
        fetchHospitals(),
        fetchDepartments().catch(() => []),
        fetchRegions().catch(() => [])
      ])
      const normalizedHosp: HospitalItem[] = hospData.map((h) => ({
        ...h,
        externalDepartments: (h.externalDepartments || []).map((d) => ({
          ...d,
          xh: d.xh || d.id.slice(-4)
        }))
      }))
      setHospitals(normalizedHosp)
      setDeptList(deptData)
      setRegionList(regData)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showAlert(`加载医院数据失败：${message}`, '加载异常', 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [loadData])

  // 省份与城市联动辅助
  const provinceOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const r of regionList) {
      if (r.s_id && !map.has(r.s_id)) {
        map.set(r.s_id, r.s_name)
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }))
  }, [regionList])

  const getCitiesForProvince = useCallback(
    (provinceId: string) => {
      if (!provinceId) return []
      return regionList.filter((r) => r.s_id === provinceId)
    },
    [regionList]
  )

  const activeDrilldownHospital = hospitals.find((h) => h.id === drilldownHospitalId) || null

  const updateHospitalField = (id: string, field: keyof HospitalItem, value: string): void => {
    setHospitals((prev) =>
      prev.map((item) => {
        if (item.id === id) {
          return { ...item, [field]: value }
        }
        return item
      })
    )
  }

  const updateHospitalDeptField = (
    deptId: string,
    field: keyof HospitalDeptItem,
    value: string
  ): void => {
    if (!drilldownHospitalId) return
    setHospitals((prev) =>
      prev.map((hosp) => {
        if (hosp.id === drilldownHospitalId) {
          const updatedDepts = (hosp.externalDepartments || []).map((dept) => {
            if (dept.id === deptId) {
              const updated = { ...dept, [field]: value }
              if (field === 'ksdl') {
                updated.ksxf = ''
              }
              return updated
            }
            return dept
          })
          return { ...hosp, externalDepartments: updatedDepts }
        }
        return hosp
      })
    )
  }

  const handleAddNewHospital = (): void => {
    const existingIds = hospitals
      .map((h) => parseInt(h.id, 10))
      .filter((n) => !isNaN(n))
    const maxId = existingIds.length > 0 ? Math.max(...existingIds) : 0
    const newId = String(maxId + 1).padStart(4, '0')

    const defaultSf = regionList.length > 0 ? regionList[0].s_id : '11'
    const defaultCs = regionList.length > 0 ? regionList[0].x_id : '1111'

    const newHospital: HospitalItem = {
      id: newId,
      name: `新医院_${newId}`,
      level: '三级甲等',
      bq: '重点医院',
      dq: '华北',
      dz: '地址待完善',
      tips: '就医前请携带身份证与病历本',
      bz: '',
      state: '启用',
      dz1: '地址1待填写',
      dz2: '',
      dz3: '',
      dq_sf: defaultSf,
      dq_cs: defaultCs,
      c_date: getToday8(),
      u_date: getToday8(),
      externalDepartments: []
    }

    setHospitals((prev) => [newHospital, ...prev])
    setNewlyAddedHospIds((prev) => [...prev, newId])
    setHospPage(1)
  }

  const handleAddNewHospitalDept = (): void => {
    if (!drilldownHospitalId || !activeDrilldownHospital) return
    const subList = activeDrilldownHospital.externalDepartments || []
    const existingXhs = subList
      .map((s) => parseInt(s.xh || s.id.slice(-4), 10))
      .filter((n) => !isNaN(n))
    const maxXh = existingXhs.length > 0 ? Math.max(...existingXhs) : 0
    const newXh = String(maxXh + 1).padStart(4, '0')
    const fullId = `${drilldownHospitalId}${newXh}`

    const defaultKsdl = deptList.length > 0 ? deptList[0].id : '0001'
    const defaultKsxf =
      deptList.length > 0 && (deptList[0].subDepartments?.length ?? 0) > 0
        ? deptList[0].subDepartments![0].id
        : `${defaultKsdl}0001`

    const newDept: HospitalDeptItem = {
      id: fullId,
      xh: newXh,
      id_yy: drilldownHospitalId,
      name: `新对外科室_${newXh}`,
      ksdl: defaultKsdl,
      ksxf: defaultKsxf,
      state: '启用',
      u_date: getToday8()
    }

    setHospitals((prev) =>
      prev.map((hosp) => {
        if (hosp.id === drilldownHospitalId) {
          return {
            ...hosp,
            externalDepartments: [newDept, ...(hosp.externalDepartments || [])]
          }
        }
        return hosp
      })
    )
    setNewlyAddedDeptIds((prev) => [...prev, fullId])
    setDeptPage(1)
  }

  const handleDeleteHospital = (id: string, name: string): void => {
    const hosp = hospitals.find((h) => h.id === id)
    const subCount = hosp?.externalDepartments?.length || 0

    setConfirmModal({
      isOpen: true,
      title: '删除医院确认',
      message:
        subCount > 0
          ? `确定要删除医院【${name || id}】吗？\n该医院下包含 ${subCount} 个关联对外科室，删除后将一并移除！`
          : `确定要删除医院【${name || id}】吗？`,
      type: 'danger',
      confirmText: '确认删除',
      cancelText: '取消',
      onConfirm: () => {
        setHospitals((prev) => prev.filter((h) => h.id !== id))
        setSelectedHospIds((prev) => prev.filter((sid) => sid !== id))
        closeConfirmModal()
      }
    })
  }

  const handleDeleteSelectedHospitals = (): void => {
    if (selectedHospIds.length === 0) {
      showAlert('请先勾选需要删除的医院', '操作提示', 'warning')
      return
    }

    setConfirmModal({
      isOpen: true,
      title: '批量删除医院确认',
      message: `确定要删除选中的 ${selectedHospIds.length} 所医院吗？\n删除后包含的对外科室数据也将一并清除。`,
      type: 'danger',
      confirmText: `删除选中的 ${selectedHospIds.length} 所医院`,
      cancelText: '取消',
      onConfirm: () => {
        setHospitals((prev) => prev.filter((h) => !selectedHospIds.includes(h.id)))
        setSelectedHospIds([])
        closeConfirmModal()
      }
    })
  }

  const handleDeleteHospitalDept = (deptId: string, deptName: string): void => {
    if (!drilldownHospitalId) return
    setConfirmModal({
      isOpen: true,
      title: '删除对外科室确认',
      message: `确定要删除对外科室【${deptName || deptId}】吗？`,
      type: 'danger',
      confirmText: '确认删除',
      cancelText: '取消',
      onConfirm: () => {
        setHospitals((prev) =>
          prev.map((hosp) => {
            if (hosp.id === drilldownHospitalId) {
              return {
                ...hosp,
                externalDepartments: (hosp.externalDepartments || []).filter((d) => d.id !== deptId)
              }
            }
            return hosp
          })
        )
        setSelectedDeptIds((prev) => prev.filter((id) => id !== deptId))
        closeConfirmModal()
      }
    })
  }

  const handleDeleteSelectedHospitalDepts = (): void => {
    if (selectedDeptIds.length === 0 || !drilldownHospitalId) {
      showAlert('请先勾选需要删除的对外科室', '操作提示', 'warning')
      return
    }

    setConfirmModal({
      isOpen: true,
      title: '批量删除对外科室确认',
      message: `确定要删除选中的 ${selectedDeptIds.length} 个对外科室吗？`,
      type: 'danger',
      confirmText: `删除选中的 ${selectedDeptIds.length} 项`,
      cancelText: '取消',
      onConfirm: () => {
        setHospitals((prev) =>
          prev.map((hosp) => {
            if (hosp.id === drilldownHospitalId) {
              return {
                ...hosp,
                externalDepartments: (hosp.externalDepartments || []).filter(
                  (d) => !selectedDeptIds.includes(d.id)
                )
              }
            }
            return hosp
          })
        )
        setSelectedDeptIds([])
        closeConfirmModal()
      }
    })
  }

  const handleSaveToDatabase = async (): Promise<void> => {
    setSaving(true)
    try {
      const prepared: HospitalItem[] = hospitals.map((h) => ({
        ...h,
        u_date: getToday8(),
        externalDepartments: (h.externalDepartments || []).map((d) => ({
          ...d,
          id: `${h.id}${d.xh || d.id.slice(-4)}`,
          xh: d.xh || d.id.slice(-4),
          id_yy: h.id,
          u_date: getToday8()
        }))
      }))
      await saveHospitals(prepared)
      setNewlyAddedHospIds([])
      setNewlyAddedDeptIds([])
      showAlert('保存成功', '提示', 'success')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showAlert(`保存失败：${message}`, '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const filteredHospitals = hospitals.filter((h) => {
    const matchKeyword =
      !appliedSearchQuery.trim() ||
      h.name.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase()) ||
      h.dz.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase()) ||
      h.dz1.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase()) ||
      h.id.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase())
    const matchStatus =
      appliedSearchStatus === 'all' ||
      (appliedSearchStatus === 'enabled' && h.state === '启用') ||
      (appliedSearchStatus === 'disabled' && h.state === '停用')
    return matchKeyword && matchStatus
  })

  const totalHospCount = filteredHospitals.length
  const totalHospPages = Math.max(1, Math.ceil(totalHospCount / hospPageSize))
  const currentHospPage = Math.min(Math.max(1, hospPage), totalHospPages)
  const pagedHospitals = filteredHospitals.slice(
    (currentHospPage - 1) * hospPageSize,
    currentHospPage * hospPageSize
  )

  const isAllCurrentPageHospSelected =
    pagedHospitals.length > 0 && pagedHospitals.every((h) => selectedHospIds.includes(h.id))

  const allFilteredDepts = (activeDrilldownHospital?.externalDepartments || []).filter((d) => {
    const matchKeyword =
      !appliedSubSearchQuery.trim() ||
      d.name.toLowerCase().includes(appliedSubSearchQuery.trim().toLowerCase()) ||
      (d.xh || d.id).toLowerCase().includes(appliedSubSearchQuery.trim().toLowerCase())
    const matchStatus =
      appliedSubSearchStatus === 'all' ||
      (appliedSubSearchStatus === 'enabled' && d.state === '启用') ||
      (appliedSubSearchStatus === 'disabled' && d.state === '停用')
    return matchKeyword && matchStatus
  })

  const totalDeptCount = allFilteredDepts.length
  const totalDeptPages = Math.max(1, Math.ceil(totalDeptCount / deptPageSize))
  const currentDeptPage = Math.min(Math.max(1, deptPage), totalDeptPages)
  const pagedDepts = allFilteredDepts.slice(
    (currentDeptPage - 1) * deptPageSize,
    currentDeptPage * deptPageSize
  )

  const isAllCurrentPageDeptsSelected =
    pagedDepts.length > 0 && pagedDepts.every((d) => selectedDeptIds.includes(d.id))

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

      {drilldownHospitalId && activeDrilldownHospital ? (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4 animate-in fade-in duration-150">
          <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setDrilldownHospitalId(null)}
                className="text-primary hover:text-primary-container font-medium flex items-center gap-0.5 cursor-pointer transition-colors text-body-sm"
              >
                <span className="material-symbols-outlined text-[18px]">arrow_back</span>
                医院管理
              </button>
              <span className="material-symbols-outlined text-[16px] text-outline">chevron_right</span>
              <h1 className="text-h2-header text-text-main font-bold">
                【{activeDrilldownHospital.name || activeDrilldownHospital.id}】对外科室
              </h1>
              <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
                共 {activeDrilldownHospital.externalDepartments?.length || 0} 个对外科室
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
                    placeholder="搜索对外科室或ID…"
                    value={subSearchDraft}
                    onChange={(e) => setSubSearchDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setAppliedSubSearchQuery(subSearchDraft)
                        setAppliedSubSearchStatus(subSearchStatusDraft)
                        setDeptPage(1)
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
                    setDeptPage(1)
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
                onClick={handleDeleteSelectedHospitalDepts}
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

              <button
                type="button"
                onClick={handleAddNewHospitalDept}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                新增对外科室
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
                        checked={isAllCurrentPageDeptsSelected}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedDeptIds((prev) => [
                              ...new Set([...prev, ...pagedDepts.map((d) => d.id)])
                            ])
                          } else {
                            const pageIds = pagedDepts.map((d) => d.id)
                            setSelectedDeptIds((prev) => prev.filter((id) => !pageIds.includes(id)))
                          }
                        }}
                        className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                      />
                    </th>
                    <th className="py-3 px-4 w-24 min-w-[90px] text-center">ID</th>
                    <th className="py-3 px-4 min-w-[200px]">科室细分名称</th>
                    <th className="py-3 px-4 min-w-[180px]">对内一级科室</th>
                    <th className="py-3 px-4 min-w-[180px]">对内二级科室</th>
                    <th className="py-3 px-4 w-32 min-w-[110px] text-center">状态</th>
                    <th className="py-3 px-4 w-40 min-w-[140px] text-center">更新时间</th>
                    <th className="py-3 px-4 w-16 min-w-[60px] text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle text-body-sm">
                  {pagedDepts.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-16 text-center text-text-muted">
                        <span className="material-symbols-outlined text-[40px] text-outline block mb-2">
                          inbox
                        </span>
                        暂无对外科室数据，点击上方“新增对外科室”开始配置
                      </td>
                    </tr>
                  ) : (
                    pagedDepts.map((sub, idx) => {
                      const isNewlyAdded = newlyAddedDeptIds.includes(sub.id)
                      const isSelected = selectedDeptIds.includes(sub.id)
                      const displayId = sub.xh || sub.id.slice(-4)

                      const selectedParentDept = deptList.find((d) => d.id === sub.ksdl)
                      const availableSubDepts = selectedParentDept?.subDepartments || []

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
                                  setSelectedDeptIds((prev) => [...prev, sub.id])
                                } else {
                                  setSelectedDeptIds((prev) => prev.filter((id) => id !== sub.id))
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
                                updateHospitalDeptField(sub.id, 'name', e.target.value)
                              }
                              placeholder="科室名称…"
                              className="w-full px-3 py-1.5 text-body-sm font-medium rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                            />
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <select
                              value={sub.ksdl}
                              onChange={(e) =>
                                updateHospitalDeptField(sub.id, 'ksdl', e.target.value)
                              }
                              className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer transition-all shadow-2xs"
                            >
                              <option value="">未选择一级科室</option>
                              {deptList.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.name} ({d.id})
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <select
                              value={sub.ksxf}
                              onChange={(e) =>
                                updateHospitalDeptField(sub.id, 'ksxf', e.target.value)
                              }
                              className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer transition-all shadow-2xs"
                            >
                              <option value="">未选择二级科室</option>
                              {availableSubDepts.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name} ({s.xh || s.id.slice(-4)})
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <StandardStateSelect
                              value={sub.state}
                              onChange={(val) => updateHospitalDeptField(sub.id, 'state', val)}
                            />
                          </td>
                          <td className="py-3 px-5 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                            {formatDisplayDate(sub.u_date)}
                          </td>
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleDeleteHospitalDept(sub.id, sub.name)}
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
              totalCount={totalDeptCount}
              currentPage={currentDeptPage}
              pageSize={deptPageSize}
              onPageChange={(p) => setDeptPage(p)}
              onPageSizeChange={(s) => setDeptPageSize(s)}
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden p-6 gap-4">
          <div className="bg-white rounded-xl border border-border-subtle p-5 shadow-xs flex flex-wrap items-center justify-between gap-4 shrink-0">
            <div className="flex items-center gap-3">
              <h1 className="text-h2-header text-text-main font-bold">医院管理</h1>
              <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
                共 {hospitals.length} 所医院
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
                    placeholder="搜索医院、地址或ID…"
                    value={searchDraft}
                    onChange={(e) => setSearchDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setAppliedSearchQuery(searchDraft)
                        setAppliedSearchStatus(searchStatusDraft)
                        setHospPage(1)
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
                        setHospPage(1)
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
                    setHospPage(1)
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
                onClick={handleDeleteSelectedHospitals}
                disabled={selectedHospIds.length === 0}
                className={
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
                  (selectedHospIds.length > 0
                    ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                    : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
                }
              >
                <span className="material-symbols-outlined text-[18px]">delete</span>
                删除 {selectedHospIds.length > 0 ? `(${selectedHospIds.length})` : ''}
              </button>

              <button
                type="button"
                onClick={handleAddNewHospital}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
              >
                <span className="material-symbols-outlined text-[18px]">add</span>
                新增医院
              </button>
            </div>
          </div>

          <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto">
              <table className="min-w-[2000px] w-full text-left border-collapse">
                <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
                  <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                    <th className="py-3 px-4 w-12 min-w-[48px] text-center">
                      <input
                        type="checkbox"
                        checked={isAllCurrentPageHospSelected}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedHospIds((prev) => [
                              ...new Set([...prev, ...pagedHospitals.map((h) => h.id)])
                            ])
                          } else {
                            const pageIds = pagedHospitals.map((h) => h.id)
                            setSelectedHospIds((prev) => prev.filter((id) => !pageIds.includes(id)))
                          }
                        }}
                        className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                      />
                    </th>
                    <th className="py-3 px-4 w-20 min-w-[80px] text-center">ID</th>
                    <th className="py-3 px-4 w-28 min-w-[110px] text-center">操作</th>
                    <th className="py-3 px-4 min-w-[220px]">医院名称</th>
                    <th className="py-3 px-4 w-32 min-w-[120px]">医院级别</th>
                    <th className="py-3 px-4 w-28 min-w-[110px]">标签</th>
                    <th className="py-3 px-4 w-36 min-w-[130px]">省份</th>
                    <th className="py-3 px-4 w-36 min-w-[130px]">城市</th>
                    <th className="py-3 px-4 min-w-[180px]">医院地址1</th>
                    <th className="py-3 px-4 min-w-[180px]">医院地址2</th>
                    <th className="py-3 px-4 min-w-[180px]">医院地址3</th>
                    <th className="py-3 px-4 min-w-[200px]">Tips</th>
                    <th className="py-3 px-4 min-w-[160px]">备注</th>
                    <th className="py-3 px-4 w-32 min-w-[110px] text-center">状态</th>
                    <th className="py-3 px-4 w-40 min-w-[140px] text-center">更新时间</th>
                    <th className="py-3 px-4 w-16 min-w-[60px] text-center">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle text-body-sm">
                  {pagedHospitals.length === 0 ? (
                    <tr>
                      <td colSpan={16} className="py-16 text-center text-text-muted">
                        <span className="material-symbols-outlined text-[40px] text-outline block mb-2">
                          inbox
                        </span>
                        暂无医院数据，点击上方“新增医院”开始配置
                      </td>
                    </tr>
                  ) : (
                    pagedHospitals.map((hosp, idx) => {
                      const isNewlyAdded = newlyAddedHospIds.includes(hosp.id)
                      const isSelected = selectedHospIds.includes(hosp.id)

                      const rowBgClass = isSelected
                        ? 'bg-primary/10 border-l-4 border-l-primary hover:bg-primary/15'
                        : isNewlyAdded
                          ? 'bg-emerald-50/90 hover:bg-emerald-100/80 border-l-4 border-l-action-green'
                          : 'hover:bg-surface-container-low/50 border-l-4 border-l-transparent'

                      return (
                        <tr
                          key={hosp.id + '_' + idx}
                          className={'transition-colors ' + rowBgClass}
                        >
                          <td className="py-3 px-4 text-center">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedHospIds((prev) => [...prev, hosp.id])
                                } else {
                                  setSelectedHospIds((prev) => prev.filter((id) => id !== hosp.id))
                                }
                              }}
                              className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                            />
                          </td>
                          <td className="py-2.5 px-3 font-mono-data text-center text-body-sm text-text-muted font-medium whitespace-nowrap">
                            {hosp.id}
                          </td>
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <StandardSubTableBtn
                              label="对外科室"
                              onClick={() => {
                                setDrilldownHospitalId(hosp.id)
                                setDeptPage(1)
                                setSelectedDeptIds([])
                              }}
                            />
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <input
                              type="text"
                              value={hosp.name}
                              onChange={(e) =>
                                updateHospitalField(hosp.id, 'name', e.target.value)
                              }
                              placeholder="医院名称…"
                              className="w-full px-3 py-1.5 text-body-sm font-medium rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                            />
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <select
                              value={hosp.level}
                              onChange={(e) =>
                                updateHospitalField(hosp.id, 'level', e.target.value)
                              }
                              className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer transition-all shadow-2xs"
                            >
                              <option value="三级甲等">三级甲等</option>
                              <option value="三级乙等">三级乙等</option>
                              <option value="二级甲等">二级甲等</option>
                              <option value="二级乙等">二级乙等</option>
                              <option value="一级甲等">一级甲等</option>
                              <option value="私立专科">私立专科</option>
                              <option value="知名诊所">知名诊所</option>
                            </select>
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <input
                              type="text"
                              value={hosp.bq}
                              onChange={(e) => updateHospitalField(hosp.id, 'bq', e.target.value)}
                              placeholder="标签…"
                              className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                            />
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap min-w-[140px]">
                            <select
                              value={hosp.dq_sf || ''}
                              onChange={(e) => {
                                const newSf = e.target.value
                                const validCities = regionList.filter((r) => r.s_id === newSf)
                                const isCurrentCityValid = validCities.some((c) => c.x_id === hosp.dq_cs)
                                const newCs = isCurrentCityValid ? hosp.dq_cs : (validCities[0]?.x_id || '')
                                setHospitals((prev) =>
                                  prev.map((item) =>
                                    item.id === hosp.id
                                      ? { ...item, dq_sf: newSf, dq_cs: newCs }
                                      : item
                                  )
                                )
                              }}
                              className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer transition-all shadow-2xs bg-surface"
                            >
                              <option value="">-- 请选择省份 --</option>
                              {provinceOptions.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap min-w-[140px]">
                            <select
                              value={hosp.dq_cs || ''}
                              onChange={(e) =>
                                updateHospitalField(hosp.id, 'dq_cs', e.target.value)
                              }
                              disabled={!hosp.dq_sf}
                              className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer transition-all shadow-2xs bg-surface disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <option value="">
                                {hosp.dq_sf ? '-- 请选择城市 --' : '请先选省份'}
                              </option>
                              {getCitiesForProvince(hosp.dq_sf).map((c) => (
                                <option key={c.x_id} value={c.x_id}>
                                  {c.x_name}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <input
                              type="text"
                              value={hosp.dz1}
                              onChange={(e) =>
                                updateHospitalField(hosp.id, 'dz1', e.target.value)
                              }
                              placeholder="医院地址1…"
                              className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                            />
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <input
                              type="text"
                              value={hosp.dz2}
                              onChange={(e) =>
                                updateHospitalField(hosp.id, 'dz2', e.target.value)
                              }
                              placeholder="医院地址2…"
                              className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                            />
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <input
                              type="text"
                              value={hosp.dz3}
                              onChange={(e) =>
                                updateHospitalField(hosp.id, 'dz3', e.target.value)
                              }
                              placeholder="医院地址3…"
                              className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                            />
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <input
                              type="text"
                              value={hosp.tips}
                              onChange={(e) =>
                                updateHospitalField(hosp.id, 'tips', e.target.value)
                              }
                              placeholder="就医提示 Tips…"
                              className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                            />
                          </td>
                          <td className="py-2.5 px-3 whitespace-nowrap">
                            <input
                              type="text"
                              value={hosp.bz}
                              onChange={(e) => updateHospitalField(hosp.id, 'bz', e.target.value)}
                              placeholder="备注…"
                              className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                            />
                          </td>
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <StandardStateSelect
                              value={hosp.state}
                              onChange={(val) => updateHospitalField(hosp.id, 'state', val)}
                            />
                          </td>
                          <td className="py-3 px-5 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                            {formatDisplayDate(hosp.u_date)}
                          </td>
                          <td className="py-2.5 px-4 text-center whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleDeleteHospital(hosp.id, hosp.name)}
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
              totalCount={totalHospCount}
              currentPage={currentHospPage}
              pageSize={hospPageSize}
              onPageChange={(p) => setHospPage(p)}
              onPageSizeChange={(s) => setHospPageSize(s)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
