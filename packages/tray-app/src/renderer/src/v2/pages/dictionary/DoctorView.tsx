import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
  DoctorItem,
  HospitalItem,
  DepartmentItem,
  RegionCityItem,
  fetchDoctors,
  saveDoctors,
  fetchHospitals,
  fetchDepartments,
  fetchRegions,
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

export default function DoctorView(): React.JSX.Element {
  const [doctorList, setDoctorList] = useState<DoctorItem[]>([])
  const [hospitals, setHospitals] = useState<HospitalItem[]>([])
  const [deptList, setDeptList] = useState<DepartmentItem[]>([])
  const [regionList, setRegionList] = useState<RegionCityItem[]>([])
  const [newlyAddedDoctorIds, setNewlyAddedDoctorIds] = useState<string[]>([])

  const [loading, setLoading] = useState<boolean>(true)
  const [saving, setSaving] = useState<boolean>(false)

  const [alertModal, setAlertModal] = useState<AlertModalConfig>({
    isOpen: false,
    title: '',
    message: '',
    type: 'info'
  })

  const [selectedDoctorIds, setSelectedDoctorIds] = useState<string[]>([])

  const [searchDraft, setSearchDraft] = useState('')
  const [searchStatusDraft, setSearchStatusDraft] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [appliedSearchQuery, setAppliedSearchQuery] = useState('')
  const [appliedSearchStatus, setAppliedSearchStatus] = useState<'all' | 'enabled' | 'disabled'>('all')

  const [doctorPage, setDoctorPage] = useState<number>(1)
  const [doctorPageSize, setDoctorPageSize] = useState<number>(10)

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
      const [doctorsData, hospData, deptData, regData] = await Promise.all([
        fetchDoctors(),
        fetchHospitals().catch(() => []),
        fetchDepartments().catch(() => []),
        fetchRegions().catch(() => [])
      ])
      setDoctorList(doctorsData)
      setHospitals(hospData)
      setDeptList(deptData)
      setRegionList(regData)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showAlert(`加载医生数据失败：${message}`, '加载异常', 'error')
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

  const updateDoctorField = (id: string, field: keyof DoctorItem, value: string): void => {
    setDoctorList((prev) =>
      prev.map((item) => {
        if (item.id === id) {
          return { ...item, [field]: value }
        }
        return item
      })
    )
  }

  const handleAddNewDoctor = (): void => {
    const existingIds = doctorList
      .map((d) => parseInt(d.id, 10))
      .filter((n) => !isNaN(n))
    const maxId = existingIds.length > 0 ? Math.max(...existingIds) : 0
    const newId = String(maxId + 1).padStart(5, '0')

    const newDoctor: DoctorItem = {
      id: newId,
      name: `医生_${newId}`,
      sex: '男',
      tel: '',
      em: '',
      dq_sf: '110000',
      dq_cs: '110100',
      yy: hospitals.length > 0 ? hospitals[0].id : '0001',
      dwks: '00010001',
      zc: '主任医师',
      jxzc: '教授',
      yyxzzw: '科主任',
      shrz: '',
      sc: '擅长各类临床诊断与治疗',
      bz: '',
      state: '启用',
      csrq: '19800101',
      c_date: getToday8(),
      u_date: getToday8()
    }

    setDoctorList((prev) => [newDoctor, ...prev])
    setNewlyAddedDoctorIds((prev) => [...prev, newId])
    setDoctorPage(1)
  }

  const handleDeleteDoctor = (id: string, name: string): void => {
    setConfirmModal({
      isOpen: true,
      title: '删除医生确认',
      message: `确定要删除医生【${name || id}】吗？`,
      type: 'danger',
      confirmText: '确认删除',
      cancelText: '取消',
      onConfirm: () => {
        setDoctorList((prev) => prev.filter((d) => d.id !== id))
        setSelectedDoctorIds((prev) => prev.filter((sid) => sid !== id))
        closeConfirmModal()
      }
    })
  }

  const handleDeleteSelectedDoctors = (): void => {
    if (selectedDoctorIds.length === 0) {
      showAlert('请先勾选需要删除的医生', '操作提示', 'warning')
      return
    }

    setConfirmModal({
      isOpen: true,
      title: '批量删除医生确认',
      message: `确定要删除选中的 ${selectedDoctorIds.length} 位医生吗？`,
      type: 'danger',
      confirmText: `删除选中的 ${selectedDoctorIds.length} 位医生`,
      cancelText: '取消',
      onConfirm: () => {
        setDoctorList((prev) => prev.filter((d) => !selectedDoctorIds.includes(d.id)))
        setSelectedDoctorIds([])
        closeConfirmModal()
      }
    })
  }

  const handleSaveToDatabase = async (): Promise<void> => {
    setSaving(true)
    try {
      const prepared: DoctorItem[] = doctorList.map((d) => ({
        ...d,
        u_date: getToday8()
      }))
      await saveDoctors(prepared)
      setNewlyAddedDoctorIds([])
      showAlert('保存成功', '提示', 'success')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showAlert(`保存失败：${message}`, '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const filteredDoctors = doctorList.filter((d) => {
    const matchKeyword =
      !appliedSearchQuery.trim() ||
      d.name.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase()) ||
      d.tel.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase()) ||
      d.sc.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase()) ||
      d.id.toLowerCase().includes(appliedSearchQuery.trim().toLowerCase())
    const matchStatus =
      appliedSearchStatus === 'all' ||
      (appliedSearchStatus === 'enabled' && d.state === '启用') ||
      (appliedSearchStatus === 'disabled' && d.state === '停用')
    return matchKeyword && matchStatus
  })

  const totalDoctorCount = filteredDoctors.length
  const totalDoctorPages = Math.max(1, Math.ceil(totalDoctorCount / doctorPageSize))
  const currentDoctorPage = Math.min(Math.max(1, doctorPage), totalDoctorPages)
  const pagedDoctors = filteredDoctors.slice(
    (currentDoctorPage - 1) * doctorPageSize,
    currentDoctorPage * doctorPageSize
  )

  const isAllCurrentPageDoctorsSelected =
    pagedDoctors.length > 0 && pagedDoctors.every((d) => selectedDoctorIds.includes(d.id))

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
          <h1 className="text-h2-header text-text-main font-bold">医生管理</h1>
          <span className="text-body-sm text-primary bg-primary/10 px-2.5 py-0.5 rounded-full border border-primary/20 font-medium">
            共 {doctorList.length} 位医生
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
                placeholder="搜索医生、医院或ID…"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setAppliedSearchQuery(searchDraft)
                    setAppliedSearchStatus(searchStatusDraft)
                    setDoctorPage(1)
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
                    setDoctorPage(1)
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
                setDoctorPage(1)
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
            onClick={handleDeleteSelectedDoctors}
            disabled={selectedDoctorIds.length === 0}
            className={
              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-body-sm font-medium transition-all shadow-xs ' +
              (selectedDoctorIds.length > 0
                ? 'bg-white text-error border border-error/30 hover:bg-red-50/50 cursor-pointer'
                : 'bg-surface-container-low text-text-muted border border-border-subtle opacity-50 cursor-not-allowed')
            }
          >
            <span className="material-symbols-outlined text-[18px]">delete</span>
            删除 {selectedDoctorIds.length > 0 ? `(${selectedDoctorIds.length})` : ''}
          </button>

          <button
            type="button"
            onClick={handleAddNewDoctor}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-all shadow-xs cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            新增医生
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 bg-white rounded-xl border border-border-subtle shadow-xs flex flex-col overflow-hidden">
        <div className="flex-1 overflow-auto">
          <table className="min-w-[2600px] w-full text-left border-collapse">
            <thead className="sticky top-0 z-10 bg-surface-container-low border-b border-border-subtle select-none">
              <tr className="text-text-muted text-body-sm font-semibold whitespace-nowrap">
                <th className="py-3 px-4 w-12 min-w-[48px] text-center">
                  <input
                    type="checkbox"
                    checked={isAllCurrentPageDoctorsSelected}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedDoctorIds((prev) => [
                          ...new Set([...prev, ...pagedDoctors.map((d) => d.id)])
                        ])
                      } else {
                        const pageIds = pagedDoctors.map((d) => d.id)
                        setSelectedDoctorIds((prev) => prev.filter((id) => !pageIds.includes(id)))
                      }
                    }}
                    className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                  />
                </th>
                <th className="py-3 px-4 w-20 min-w-[80px] text-center">ID</th>
                <th className="py-3 px-4 min-w-[140px]">医生名称</th>
                <th className="py-3 px-4 w-24 min-w-[90px] text-center">性别</th>
                <th className="py-3 px-4 w-32 min-w-[120px] text-center">出生日期</th>
                <th className="py-3 px-4 min-w-[140px]">电话号码</th>
                <th className="py-3 px-4 min-w-[160px]">电子邮箱</th>
                <th className="py-3 px-4 w-36 min-w-[130px]">省份</th>
                <th className="py-3 px-4 w-36 min-w-[130px]">城市</th>
                <th className="py-3 px-4 min-w-[180px]">医院</th>
                <th className="py-3 px-4 min-w-[180px]">科室</th>
                <th className="py-3 px-4 min-w-[140px]">职称</th>
                <th className="py-3 px-4 min-w-[140px]">教学职称</th>
                <th className="py-3 px-4 min-w-[140px]">医院行政职务</th>
                <th className="py-3 px-4 min-w-[160px]">社会任职</th>
                <th className="py-3 px-4 min-w-[200px]">擅长</th>
                <th className="py-3 px-4 min-w-[160px]">备注</th>
                <th className="py-3 px-4 w-32 min-w-[110px] text-center">状态</th>
                <th className="py-3 px-4 w-40 min-w-[140px] text-center">创建时间</th>
                <th className="py-3 px-4 w-40 min-w-[140px] text-center">更新时间</th>
                <th className="py-3 px-4 w-16 min-w-[60px] text-center">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle text-body-sm">
              {pagedDoctors.length === 0 ? (
                <tr>
                  <td colSpan={21} className="py-16 text-center text-text-muted">
                    <span className="material-symbols-outlined text-[40px] text-outline block mb-2">
                      inbox
                    </span>
                    暂无医生数据，点击上方“新增医生”开始录入
                  </td>
                </tr>
              ) : (
                pagedDoctors.map((doc, idx) => {
                  const isNewlyAdded = newlyAddedDoctorIds.includes(doc.id)
                  const isSelected = selectedDoctorIds.includes(doc.id)

                  const currentHosp = hospitals.find((h) => h.id === doc.yy)
                  const availableExternalDepts = currentHosp?.externalDepartments || []

                  const rowBgClass = isSelected
                    ? 'bg-primary/10 border-l-4 border-l-primary hover:bg-primary/15'
                    : isNewlyAdded
                      ? 'bg-emerald-50/90 hover:bg-emerald-100/80 border-l-4 border-l-action-green'
                      : 'hover:bg-surface-container-low/50 border-l-4 border-l-transparent'

                  return (
                    <tr
                      key={doc.id + '_' + idx}
                      className={'transition-colors ' + rowBgClass}
                    >
                      <td className="py-3 px-4 text-center">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedDoctorIds((prev) => [...prev, doc.id])
                            } else {
                              setSelectedDoctorIds((prev) => prev.filter((id) => id !== doc.id))
                            }
                          }}
                          className="w-4 h-4 rounded border-border-subtle text-primary focus:ring-primary cursor-pointer accent-primary align-middle"
                        />
                      </td>
                      <td className="py-2.5 px-3 font-mono-data text-center text-body-sm text-text-muted font-medium whitespace-nowrap">
                        {doc.id}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <input
                          type="text"
                          value={doc.name}
                          onChange={(e) => updateDoctorField(doc.id, 'name', e.target.value)}
                          placeholder="医生姓名…"
                          className="w-full px-3 py-1.5 text-body-sm font-medium rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                        />
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap text-center">
                        <select
                          value={doc.sex}
                          onChange={(e) => updateDoctorField(doc.id, 'sex', e.target.value)}
                          className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer transition-all shadow-2xs text-center"
                        >
                          <option value="男">男</option>
                          <option value="女">女</option>
                        </select>
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap text-center">
                        <input
                          type="text"
                          value={doc.csrq}
                          onChange={(e) => updateDoctorField(doc.id, 'csrq', e.target.value)}
                          placeholder="如 19800101"
                          className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs text-center"
                        />
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <input
                          type="text"
                          value={doc.tel}
                          onChange={(e) => updateDoctorField(doc.id, 'tel', e.target.value)}
                          placeholder="手机号码…"
                          className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                        />
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <input
                          type="text"
                          value={doc.em}
                          onChange={(e) => updateDoctorField(doc.id, 'em', e.target.value)}
                          placeholder="电子邮箱…"
                          className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                        />
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap min-w-[140px]">
                        <select
                          value={doc.dq_sf || ''}
                          onChange={(e) => {
                            const newSf = e.target.value
                            const validCities = regionList.filter((r) => r.s_id === newSf)
                            const isCurrentCityValid = validCities.some((c) => c.x_id === doc.dq_cs)
                            const newCs = isCurrentCityValid ? doc.dq_cs : (validCities[0]?.x_id || '')
                            setDoctorList((prev) =>
                              prev.map((item) =>
                                item.id === doc.id
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
                          value={doc.dq_cs || ''}
                          onChange={(e) => updateDoctorField(doc.id, 'dq_cs', e.target.value)}
                          disabled={!doc.dq_sf}
                          className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer transition-all shadow-2xs bg-surface disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <option value="">
                            {doc.dq_sf ? '-- 请选择城市 --' : '请先选省份'}
                          </option>
                          {getCitiesForProvince(doc.dq_sf).map((c) => (
                            <option key={c.x_id} value={c.x_id}>
                              {c.x_name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <select
                          value={doc.yy}
                          onChange={(e) => updateDoctorField(doc.id, 'yy', e.target.value)}
                          className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer transition-all shadow-2xs"
                        >
                          <option value="">未选择医院</option>
                          {hospitals.map((h) => (
                            <option key={h.id} value={h.id}>
                              {h.name} ({h.id})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <select
                          value={doc.dwks}
                          onChange={(e) => updateDoctorField(doc.id, 'dwks', e.target.value)}
                          className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer transition-all shadow-2xs"
                        >
                          <option value="">未选择科室</option>
                          {availableExternalDepts.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name} ({d.xh || d.id.slice(-4)})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <input
                          type="text"
                          value={doc.zc}
                          onChange={(e) => updateDoctorField(doc.id, 'zc', e.target.value)}
                          placeholder="如 主任医师…"
                          className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                        />
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <input
                          type="text"
                          value={doc.jxzc}
                          onChange={(e) => updateDoctorField(doc.id, 'jxzc', e.target.value)}
                          placeholder="如 教授/副教授…"
                          className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                        />
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <input
                          type="text"
                          value={doc.yyxzzw}
                          onChange={(e) => updateDoctorField(doc.id, 'yyxzzw', e.target.value)}
                          placeholder="如 院长/科室主任…"
                          className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                        />
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <input
                          type="text"
                          value={doc.shrz}
                          onChange={(e) => updateDoctorField(doc.id, 'shrz', e.target.value)}
                          placeholder="社会兼职或学术学会职务…"
                          className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                        />
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <input
                          type="text"
                          value={doc.sc}
                          onChange={(e) => updateDoctorField(doc.id, 'sc', e.target.value)}
                          placeholder="擅长病种或技术…"
                          className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                        />
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <input
                          type="text"
                          value={doc.bz}
                          onChange={(e) => updateDoctorField(doc.id, 'bz', e.target.value)}
                          placeholder="备注…"
                          className="w-full px-3 py-1.5 text-body-sm rounded-md border border-border-subtle hover:border-primary/50 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all shadow-2xs"
                        />
                      </td>
                      <td className="py-2.5 px-4 text-center whitespace-nowrap">
                        <StandardStateSelect
                          value={doc.state}
                          onChange={(val) => updateDoctorField(doc.id, 'state', val)}
                        />
                      </td>
                      <td className="py-3 px-5 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                        {formatDisplayDate(doc.c_date)}
                      </td>
                      <td className="py-3 px-5 text-center whitespace-nowrap font-mono-data text-body-sm text-text-muted">
                        {formatDisplayDate(doc.u_date)}
                      </td>
                      <td className="py-2.5 px-4 text-center whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => handleDeleteDoctor(doc.id, doc.name)}
                          className="inline-flex items-center justify-center p-1.5 rounded-md text-outline hover:text-error hover:bg-red-50 transition-colors cursor-pointer"
                          title="删除此医生"
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
          totalCount={totalDoctorCount}
          currentPage={currentDoctorPage}
          pageSize={doctorPageSize}
          onPageChange={(p) => setDoctorPage(p)}
          onPageSizeChange={(s) => setDoctorPageSize(s)}
        />
      </div>
    </div>
  )
}
