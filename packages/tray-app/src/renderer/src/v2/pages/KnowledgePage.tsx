/**
 * 知识库（静态占位）。后端暂无知识库数据源；先放一个结构化占位，
 * 等确定数据来源（如医院/科室指南、绿通办理流程、常见问题）再接真实内容。
 */
const SECTIONS = [
  { icon: 'local_hospital', title: '医院 / 科室指引', desc: '各合作医院的科室分布、专家特长、预约规则' },
  { icon: 'route', title: '绿通办理流程', desc: '挂号 / 住院 / 检查加急 / 会诊等各业务的标准办理步骤' },
  { icon: 'quiz', title: '常见问题', desc: '客户高频问题与标准话术' },
  { icon: 'gavel', title: '政策与权益', desc: '泰康 / 平安等各保司绿通权益与使用规则' }
]

export default function KnowledgePage(): React.JSX.Element {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-surface-bg">
      <div className="max-w-4xl mx-auto p-8">
        <div className="flex items-center gap-2 mb-1">
          <h1 className="text-h2-header text-text-main">知识库</h1>
          <span className="text-label-caps px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">建设中</span>
        </div>
        <p className="text-body-sm text-text-muted mb-6">
          后续接入医院指引、办理流程、常见问题等内容，帮助专员快速查询。数据源确定后这里会替换为真实内容。
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {SECTIONS.map((s) => (
            <div
              key={s.title}
              className="bg-white rounded-lg border border-border-subtle p-4 flex gap-3 opacity-70"
            >
              <span className="material-symbols-outlined text-primary shrink-0" style={{ fontSize: '24px' }}>
                {s.icon}
              </span>
              <div className="min-w-0">
                <div className="text-body-md font-semibold text-text-main">{s.title}</div>
                <p className="text-body-sm text-text-muted mt-0.5">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
