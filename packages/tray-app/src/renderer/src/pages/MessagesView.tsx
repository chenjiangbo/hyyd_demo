import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
// CaptureConversation / CaptureMessage 是 env.d.ts 里声明的全局类型

const LIST_POLL_MS = 10_000
const DETAIL_POLL_MS = 10_000

type Channel = 'wechat' | 'wxwork'

export default function MessagesView(): React.JSX.Element {
  const [convs, setConvs] = useState<CaptureConversation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 微信和企微是两套独立 IM，不能混在一起看，默认看企微（当前在测）
  const [channel, setChannel] = useState<Channel>('wxwork')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [query, setQuery] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (!window.api?.getCaptureConversations) {
        throw new Error('采集接口不可用（非 Windows 客户端或 preload 未加载）')
      }
      const data = await window.api.getCaptureConversations(channel)
      setConvs(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [channel])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 后台 10s 轮询会话列表
  useEffect(() => {
    const t = setInterval(refresh, LIST_POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  const filtered = useMemo(() => {
    if (!query.trim()) return convs
    const q = query.trim().toLowerCase()
    return convs.filter(
      (c) =>
        (c.conversationTitle ?? '').toLowerCase().includes(q) ||
        (c.phone ?? '').includes(q) ||
        c.lastMessagePreview.toLowerCase().includes(q)
    )
  }, [convs, query])

  const selected = useMemo(
    () => convs.find((c) => c.id === selectedId) ?? null,
    [convs, selectedId]
  )

  return (
    <div className="flex h-full">
      {/* 左侧会话列表 */}
      <div className="w-80 border-r border-slate-200 flex flex-col bg-white">
        <header className="px-4 py-3 border-b border-slate-200">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-base font-semibold text-slate-800">
              消息记录 <span className="text-slate-400 font-normal">({convs.length})</span>
            </h1>
            <button
              onClick={refresh}
              disabled={loading}
              className="text-xs px-2 py-1 border border-slate-300 hover:bg-slate-50 disabled:opacity-50 rounded"
            >
              {loading ? '…' : '🔄'}
            </button>
          </div>
          {/* 渠道切换：微信 / 企微 互斥，不可合并 */}
          <div className="flex items-center gap-1 text-xs">
            {(
              [
                { key: 'wechat', label: '💚 微信' },
                { key: 'wxwork', label: '💙 企微' }
              ] as { key: Channel; label: string }[]
            ).map((t) => (
              <button
                key={t.key}
                onClick={() => {
                  setChannel(t.key)
                  setSelectedId(null)
                }}
                className={`px-3 py-1 rounded ${
                  channel === t.key
                    ? 'bg-slate-800 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </header>
        <div className="px-3 py-2 border-b border-slate-100">
          <input
            type="text"
            placeholder="搜索会话名 / 号码 / 内容"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded focus:outline-none focus:border-blue-400"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {error && (
            <div className="mx-3 my-2 px-3 py-2 bg-red-50 border border-red-200 text-xs text-red-700 rounded">
              ❌ {error}
            </div>
          )}
          {filtered.length === 0 && !loading && !error && (
            <div className="text-center py-12 text-slate-400 text-sm">
              {query ? '无匹配结果' : `暂无${channel === 'wechat' ? '微信' : '企微'}会话`}
            </div>
          )}
          {filtered.map((c) => (
            <ConversationCard
              key={c.id}
              conv={c}
              active={c.id === selectedId}
              onClick={() => setSelectedId(c.id)}
            />
          ))}
        </div>
      </div>

      {/* 右侧消息流 */}
      <div className="flex-1 overflow-hidden flex flex-col bg-slate-50">
        {selected ? (
          <ConversationDetail conversation={selected} key={selected.id} />
        ) : (
          <div className="h-full flex items-center justify-center text-slate-400 text-sm">
            请选择左侧会话查看消息记录
          </div>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// 会话卡片
// ─────────────────────────────────────────────────────────

const CLASSIFICATION_LABEL: Record<string, string> = {
  named_customer: '客户',
  work_group: '工作群',
  unknown_group: '群聊',
  unknown_private: '私聊',
  unknown_thread: '未知'
}

function ConversationCard({
  conv,
  active,
  onClick
}: {
  conv: CaptureConversation
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  const channelIcon = conv.channel === 'wechat' ? '💚' : '💙'
  const title = conv.conversationTitle || conv.phone || '未识别会话'
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-3 border-b border-slate-100 hover:bg-slate-50 transition ${
        active ? 'bg-blue-50 border-l-4 border-l-blue-500' : 'border-l-4 border-l-transparent'
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-800 truncate">
          {channelIcon} {title}
        </span>
        <span className="text-[10px] text-slate-400 shrink-0 ml-2">{relativeTime(conv.lastSeenAt)}</span>
      </div>
      <div className="text-xs text-slate-500 mt-1 truncate">{conv.lastMessagePreview || '（无文本预览）'}</div>
      <div className="flex items-center justify-between mt-1.5">
        <span className="text-[10px] text-slate-400">{conv.messageCount} 条</span>
        {conv.classification && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
            {CLASSIFICATION_LABEL[conv.classification] ?? conv.classification}
          </span>
        )}
      </div>
    </button>
  )
}

// ─────────────────────────────────────────────────────────
// 详情：消息流
// ─────────────────────────────────────────────────────────

function ConversationDetail({ conversation }: { conversation: CaptureConversation }): React.JSX.Element {
  const [messages, setMessages] = useState<CaptureMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (!window.api?.getCaptureMessages) throw new Error('采集接口不可用')
      const data = await window.api.getCaptureMessages(conversation.id)
      setMessages(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [conversation.id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const t = setInterval(load, DETAIL_POLL_MS)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages.length])

  const channelIcon = conversation.channel === 'wechat' ? '💚' : '💙'
  const channelName = conversation.channel === 'wechat' ? '微信' : '企微'
  const title = conversation.conversationTitle || conversation.phone || '未识别会话'

  return (
    <>
      <div className="px-6 py-3 bg-white border-b border-slate-200 flex items-center justify-between">
        <div>
          <div className="text-base font-semibold text-slate-800">
            {channelIcon} {title}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {channelName} · {messages.length} 条消息块
            {conversation.phone ? ` · ${conversation.phone}` : ''}
          </div>
        </div>
        <span className="text-[11px] text-slate-400">
          采集证据 · 仅供参考（OCR 还原，可能有误差）
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-3">
        {loading && messages.length === 0 && (
          <div className="text-center text-sm text-slate-400 py-8">加载中…</div>
        )}
        {error && (
          <div className="px-3 py-2 bg-red-50 border border-red-200 text-sm text-red-700 rounded">
            ❌ {error}
          </div>
        )}
        {!loading && messages.length === 0 && !error && (
          <div className="text-center text-sm text-slate-400 py-8">该会话暂无识别出的消息块</div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────
// 消息气泡
// ─────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: CaptureMessage }): React.JSX.Element {
  // 系统消息居中
  if (message.senderType === 'system') {
    return (
      <div className="flex justify-center">
        <span className="text-[11px] text-slate-400 bg-slate-100 px-2 py-0.5 rounded">
          {message.content}
        </span>
      </div>
    )
  }
  const isMine = message.senderType === 'self'
  const time = new Date(message.firstSeenAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  })
  return (
    <div className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[70%] flex flex-col ${isMine ? 'items-end' : 'items-start'}`}>
        {message.senderType === 'unknown' && (
          <div className="text-[10px] text-slate-400 mb-1 px-2">说话人未定</div>
        )}
        <div
          className={`px-3 py-2 rounded-lg text-sm shadow-sm whitespace-pre-wrap break-words ${
            isMine
              ? 'bg-blue-500 text-white rounded-tr-sm'
              : 'bg-white text-slate-800 rounded-tl-sm border border-slate-200'
          }`}
        >
          {message.content}
        </div>
        <div className={`text-[10px] text-slate-400 mt-1 px-2 ${isMine ? 'text-right' : ''}`}>
          {time}
          {message.seenCount > 1 ? ` · 出现${message.seenCount}次` : ''}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────

function relativeTime(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}
