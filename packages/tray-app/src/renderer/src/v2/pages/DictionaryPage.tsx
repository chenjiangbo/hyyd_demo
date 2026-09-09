import React, { useState } from 'react'
import InternalDepartmentView from './dictionary/InternalDepartmentView'
import HospitalView from './dictionary/HospitalView'
import DoctorView from './dictionary/DoctorView'
import ChannelView from './dictionary/ChannelView'
import InternalProductView from './dictionary/InternalProductView'
import PaymentChannelView from './dictionary/PaymentChannelView'
import EscortView from './dictionary/EscortView'

interface MenuItem {
  key: string
  label: string
  icon: string
}

interface MenuGroup {
  key: string
  title: string
  icon: string
  children: MenuItem[]
}

const MENU_GROUPS: MenuGroup[] = [
  {
    key: 'hospital_manage',
    title: '医院管理',
    icon: 'local_hospital',
    children: [
      { key: 'internal_department', label: '对内科室管理', icon: 'category' },
      { key: 'hospital_manage_sub', label: '医院管理', icon: 'corporate_fare' },
      { key: 'doctor_manage', label: '医生管理', icon: 'medical_information' }
    ]
  },
  {
    key: 'channel_manage',
    title: '渠道管理',
    icon: 'alt_route',
    children: [
      { key: 'channel_manage_sub', label: '渠道管理', icon: 'hub' },
      { key: 'internal_product', label: '产品管理', icon: 'inventory_2' },
      { key: 'payment_channel', label: '交付支出渠道', icon: 'payments' }
    ]
  },
  {
    key: 'other_manage',
    title: '其他',
    icon: 'more_horiz',
    children: [
      { key: 'escort_manage', label: '陪诊人管理', icon: 'support_agent' }
    ]
  }
]

export default function DictionaryPage(): React.JSX.Element {
  const [activeMenu, setActiveMenu] = useState<string>('internal_department')
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

  const toggleGroup = (groupKey: string): void => {
    setCollapsedGroups((prev) => ({
      ...prev,
      [groupKey]: !prev[groupKey]
    }))
  }

  return (
    <div className="flex h-full w-full bg-surface-bg overflow-hidden">
      {/* ─── 左侧树形字典菜单 ─── */}
      <aside className="w-64 shrink-0 bg-white border-r border-border-subtle flex flex-col select-none overflow-y-auto">
        <div className="p-4 border-b border-border-subtle flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-[20px]">menu_book</span>
            <h2 className="text-h3-title text-text-main font-semibold">字典维护</h2>
          </div>
          <span className="text-[11px] text-text-muted bg-surface-container-low px-2 py-0.5 rounded-full border border-border-subtle font-medium">
            7 个模块
          </span>
        </div>

        <div className="p-3 space-y-3">
          {MENU_GROUPS.map((group) => {
            const isCollapsed = !!collapsedGroups[group.key]
            return (
              <div key={group.key} className="space-y-1">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  className="w-full flex items-center justify-between px-2.5 py-1.5 text-body-sm font-semibold text-text-muted hover:text-text-main hover:bg-surface-container-low/60 rounded-lg transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-[18px] text-outline">
                      {group.icon}
                    </span>
                    <span>{group.title}</span>
                  </div>
                  <span
                    className="material-symbols-outlined text-[16px] text-outline transform transition-transform duration-200"
                    style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
                  >
                    expand_more
                  </span>
                </button>

                {!isCollapsed && (
                  <div className="pl-2 space-y-0.5">
                    {group.children.map((item) => {
                      const isActive = activeMenu === item.key
                      return (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => setActiveMenu(item.key)}
                          className={
                            'w-full text-left pl-7 pr-3 py-2 text-body-sm rounded-lg transition-all flex items-center justify-between cursor-pointer ' +
                            (isActive
                              ? 'bg-primary text-white font-semibold shadow-xs'
                              : 'text-text-main hover:bg-surface-container-low hover:text-primary')
                          }
                        >
                          <div className="flex items-center gap-2">
                            <span>{item.label}</span>
                          </div>
                          {isActive && (
                            <span className="material-symbols-outlined text-[16px] text-white/80">
                              chevron_right
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </aside>

      {/* ─── 右侧主体内容区域 ─── */}
      <main className="flex-1 min-w-0 bg-surface-bg overflow-hidden flex flex-col">
        {activeMenu === 'internal_department' && <InternalDepartmentView />}
        {activeMenu === 'hospital_manage_sub' && <HospitalView />}
        {activeMenu === 'doctor_manage' && <DoctorView />}
        {activeMenu === 'channel_manage_sub' && <ChannelView />}
        {activeMenu === 'internal_product' && <InternalProductView />}
        {activeMenu === 'payment_channel' && <PaymentChannelView />}
        {activeMenu === 'escort_manage' && <EscortView />}
      </main>
    </div>
  )
}
