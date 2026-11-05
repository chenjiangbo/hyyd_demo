import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi } from '../api/client'
import type { NativeChatAdminMessage, NativeChatConversationSummary } from '../api/types'
import { LoadMore } from '../components/LoadMore'
import { Card, EmptyBlock, ErrorBlock, LoadingBlock, PageHeader } from '../components/ui'
import { Lightbox } from '../components/Lightbox'
import { fmtTimeFull } from '../lib/format'

const channelName = (channel: string): string => channel === 'wxwork' ? '企微' : '微信'

function applicationLinkLabel(status: string, applicationNo: string | null): string {
  if (status === 'matched' && applicationNo) return `已关联申领号：${applicationNo}`
  if (status === 'conflict') return '业务归属待核对'
  if (status === 'ambiguous') return '申领号候选有多个匹配，待核对'
  if (status === 'name_mismatch') return '候选与客户姓名不一致，待核对'
  if (status === 'unmatched') return '未找到对应申领号，待核对'
  return '会话标题未识别出申领号'
}

function messageBusinessLinkLabel(message: NativeChatAdminMessage): string | null {
  const sourceName = message.applicationLinkSource === 'conversation_title'
    ? '按会话名称'
    : message.applicationLinkSource === 'dispatch_channel_order_no' ? '按派单中的渠道订单号' : null
  if (message.applicationLinkStatus === 'matched' && message.applicationNo) {
    return `关联申领号：${message.applicationNo}${message.orderId !== null ? ` · 订单记录 ${message.orderId}` : ''}${sourceName ? ` · ${sourceName}` : ''}`
  }
  if (message.applicationLinkStatus === 'conflict') return '业务归属待核对'
  if (message.applicationLinkStatus === 'ambiguous') return '申领号对应多个业务记录，待核对'
  if (message.applicationLinkStatus === 'unmatched') return '暂未关联申领号'
  return null
}
const kindName = (kind: string): string => ({
  text: '文字', image: '图片', file: '文件', video: '视频', audio: '音频', voice: '语音',
  link: '链接', location: '位置', emoji: '表情', system: '系统消息', merged: '合并消息', unknown: '其他'
}[kind] ?? kind)
const directionName = (direction: string): string => ({
  incoming: '收到', outgoing: '发出', system: '系统', unknown: '方向未知'
}[direction] ?? direction)

function attachmentStateName(state: string, availableInStorage: boolean): string {
  if (availableInStorage) return '已上传，可查看'
  return ({
    available: '已采集，尚未上传',
    not_downloaded: '源端尚未下载',
    not_found: '本机文件未找到',
    ambiguous: '文件匹配不唯一',
    invalid: '文件校验失败',
    unsupported: '当前不支持此类型',
    error: '获取失败'
  } as Record<string, string>)[state] ?? `状态：${state}`
}

function formatBytes(value: string | null): string {
  if (value === null) return '大小未知'
  const bytes = BigInt(value)
  if (bytes < 1024n) return `${bytes} B`
  if (bytes < 1024n * 1024n) return `${(Number(bytes) / 1024).toFixed(1)} KB`
  if (bytes < 1024n * 1024n * 1024n) return `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MB`
  return `${(Number(bytes) / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function candidateText(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join('、') : value == null || value === '' ? '未提供' : String(value)
}

function candidateTime(value: unknown): string {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : '未提供'
}

function AttachmentMatchCandidates({ sourceMetadata }: { sourceMetadata: Record<string, unknown> | null }): React.JSX.Element | null {
  if (!sourceMetadata) return null
  const resourceRecords = Array.isArray(sourceMetadata.candidateResourceRecords)
    ? sourceMetadata.candidateResourceRecords.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
    : []
  const localFiles = Array.isArray(sourceMetadata.candidateFiles)
    ? sourceMetadata.candidateFiles.map(asRecord).filter((item): item is Record<string, unknown> => item !== null)
    : []
  if (!resourceRecords.length && !localFiles.length) return null
  return (
    <details className="basis-full text-fg-muted">
      <summary className="cursor-pointer">查看匹配候选</summary>
      <div className="mt-2 space-y-2 break-all">
        {resourceRecords.map((record, index) => (
          <div key={`resource-${index}`} className="rounded border border-line px-2 py-1">
            <div>资源记录：{candidateText(record.originalName || record.localName)}</div>
            {typeof record.localName === 'string' && typeof record.originalName === 'string' && <div>本地文件名：{candidateText(record.localName)}</div>}
            {record.byteSize != null && <div>源文件大小：{candidateText(record.byteSize)} 字节</div>}
            <div>消息记录 ID：{candidateText(record.messageIds)}</div>
            {record.resourceIds != null && <div>资源 ID：{candidateText(record.resourceIds)}</div>}
            {typeof record.packedInfoSha256 === 'string' && <div>元数据指纹：{candidateText(record.packedInfoSha256)}</div>}
          </div>
        ))}
        {localFiles.map((file, index) => (
          <div key={`local-${index}`} className="rounded border border-line px-2 py-1">
            <div>本机文件：{candidateText(file.fileName)}</div>
            <div>文件大小：{candidateText(file.byteSize)} 字节</div>
            {file.relativePath != null && <div>所在位置：{candidateText(file.relativePath)}</div>}
            {file.modifiedAt != null && <div>本机修改时间：{candidateTime(file.modifiedAt)}</div>}
            {typeof file.sha256 === 'string' && <div>内容指纹：{candidateText(file.sha256)}</div>}
          </div>
        ))}
      </div>
    </details>
  )
}

function ImageAnalysisLog({
  attachment,
  enabled,
  receivedAt,
  analysisStartAt
}: {
  attachment: NativeChatAdminMessage['attachments'][number]
  enabled: boolean | undefined
  receivedAt: string
  analysisStartAt: string | undefined
}): React.JSX.Element | null {
  if (attachment.kind !== 'image') return null
  const source = asRecord(attachment.sourceMetadata)
  const analysis = asRecord(source?.imageAnalysis)
  if (analysisStartAt && Date.parse(receivedAt) < Date.parse(analysisStartAt) + 8 * 60 * 60 * 1000 && analysis?.status !== 'completed') {
    return <div className="mt-2 rounded border border-line px-3 py-2 text-xs text-fg-muted">图片 AI：上线前图片，未自动分析</div>
  }
  if (!analysis) {
    const text = enabled === false
      ? '图片 AI 当前已关闭，尚未分析'
      : source?.rendition === 'thumbnail'
        ? '等待清晰大图后分析'
        : '等待图片 AI 分析'
    return <div className="mt-2 rounded border border-line px-3 py-2 text-xs text-fg-muted">图片 AI：{text}</div>
  }

  const status = typeof analysis.status === 'string' ? analysis.status : 'unknown'
  const statusLabel = ({
    pending: '等待分析',
    processing: '正在分析',
    retrying: '分析失败，等待重试',
    failed: '分析失败',
    completed: '识别完成'
  } as Record<string, string>)[status] ?? `状态：${status}`
  const effectiveStatusLabel = enabled === false && (status === 'pending' || status === 'retrying')
    ? '已暂停（图片 AI 当前关闭）'
    : statusLabel
  const imageType = typeof analysis.imageType === 'string' ? analysis.imageType : null
  const description = typeof analysis.description === 'string' ? analysis.description : null
  const visibleText = typeof analysis.visibleText === 'string' ? analysis.visibleText : null
  const error = typeof analysis.error === 'string' ? analysis.error : null
  const match = asRecord(analysis.registrationMatch)
  const managerResolution = asRecord(match?.managerResolution)
  const notApplicable = managerResolution?.status === 'manager_not_applicable'
  const managerConfirmed = managerResolution?.status === 'manager_confirmed'
  const matchStatus = typeof match?.status === 'string' ? match.status : null
  const matchStatusLabel = matchStatus ? ({
    pending: '等待申领号和订单匹配',
    processing: '正在匹配申领号和订单',
    retrying: '匹配失败，等待重试',
    failed: '申领号或订单匹配失败',
    completed: '匹配分析完成'
  } as Record<string, string>)[matchStatus] ?? `匹配状态：${matchStatus}` : null
  const effectiveMatchStatusLabel = notApplicable ? '已放弃关联' : managerConfirmed ? '已确认订单' : enabled === false && (matchStatus === 'pending' || matchStatus === 'retrying')
    ? '已暂停（图片 AI 当前关闭）'
    : matchStatusLabel
  const applicationNo = notApplicable ? null : managerConfirmed && typeof managerResolution?.applicationNo === 'string' ? managerResolution.applicationNo : typeof match?.applicationNo === 'string' ? match.applicationNo : null
  const orderId = notApplicable ? null : managerConfirmed && typeof managerResolution?.orderId === 'number' ? managerResolution.orderId : typeof match?.orderId === 'number' ? match.orderId : null
  const matchReason = typeof match?.reason === 'string' ? match.reason : null
  const matchError = typeof match?.error === 'string' ? match.error : null
  const visibleFields = Array.isArray(analysis.visibleFields) ? analysis.visibleFields.map(asRecord).filter((field): field is Record<string, unknown> => field !== null) : []
  const candidates = Array.isArray(match?.candidateApplications) ? match.candidateApplications.map(asRecord).filter((item): item is Record<string, unknown> => item !== null) : []

  return (
    <div className="basis-full mt-2 space-y-1 rounded border border-accent/20 bg-accent-soft/30 px-3 py-2 text-xs">
      <div className="font-medium text-fg">图片 AI：{effectiveStatusLabel}{imageType ? ` · ${imageType}` : ''}</div>
      {description && <div className="whitespace-pre-wrap break-words text-fg-muted">{description}</div>}
      {visibleText && <details className="text-fg-muted"><summary className="cursor-pointer">查看图片识别文字</summary><div className="mt-1 whitespace-pre-wrap break-words">{visibleText}</div></details>}
      {visibleFields.length > 0 && <details className="text-fg-muted"><summary className="cursor-pointer">查看识别字段</summary>{visibleFields.map((field, index) => <div key={index} className="break-words">{String(field.label ?? '')}：{String(field.value ?? '')}</div>)}</details>}
      {error && <div className="whitespace-pre-wrap break-words text-danger">识别错误：{error}</div>}
      {effectiveMatchStatusLabel && <div className="font-medium text-fg">挂号归属：{effectiveMatchStatusLabel}</div>}
      {applicationNo && <div className="text-fg-muted">申领号：{applicationNo}</div>}
      {orderId !== null && <div className="text-fg-muted">{managerConfirmed ? '已确认订单 ID' : '建议订单 ID'}：{orderId}</div>}
      {matchReason && <div className="whitespace-pre-wrap break-words text-fg-muted">匹配说明：{matchReason}</div>}
      {matchError && <div className="whitespace-pre-wrap break-words text-danger">匹配错误：{matchError}</div>}
      {candidates.length > 0 && <details className="text-fg-muted"><summary className="cursor-pointer">查看申领号和订单候选（{candidates.length}）</summary>{candidates.map((candidate, index) => {
        const orders = Array.isArray(candidate.orders) ? candidate.orders.map(asRecord).filter((item): item is Record<string, unknown> => item !== null) : []
        return <div className="mt-2 break-words" key={index}><div>申领号：{String(candidate.applicationNo ?? '')}{typeof candidate.confidence === 'number' ? ` · AI 匹配度 ${candidate.confidence}%` : ''}</div>{orders.map((order, orderIndex) => <div key={orderIndex}>订单：{String(order.sourceOrderNo || order.orderId || '')}{typeof order.confidence === 'number' ? ` · AI 匹配度 ${order.confidence}%` : ''}</div>)}</div>
      })}</details>}
      {!match && imageType === '挂号凭证' && status === 'completed' && (
        <div className="text-fg-muted">{enabled === false
          ? '图片已识别为挂号凭证；图片 AI 当前已关闭，尚未分析申领号和订单归属。'
          : '图片已识别为挂号凭证，尚无订单匹配记录。'}</div>
      )}
    </div>
  )
}

export default function NativeChatRecordsPage(): React.JSX.Element {
  const [channel, setChannel] = useState<'wechat' | 'wxwork'>('wechat')
  const [accountKey, setAccountKey] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [videoPreview, setVideoPreview] = useState<string | null>(null)
  const [clearMessagesResult, setClearMessagesResult] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const accounts = useQuery({
    queryKey: ['native-chat-record-accounts', channel],
    queryFn: () => adminApi.nativeChatAccounts(channel)
  })
  const selectedAccount = accounts.data?.find((account) => `${account.employeeId}\u001f${account.accountId}` === accountKey) ?? null
  const clearAccountMessages = useMutation({
    mutationFn: adminApi.clearNativeChatAccountMessages
  })
  const resolveMessageLink = useMutation({
    mutationFn: (input: { messageId: number; applicationNo: string; orderId: number | null }) =>
      adminApi.resolveNativeChatMessageBusinessLink(input.messageId, { applicationNo: input.applicationNo, orderId: input.orderId })
  })
  const conversations = useInfiniteQuery({
    queryKey: ['native-chat-record-conversations', channel, selectedAccount?.employeeId, selectedAccount?.accountId, search],
    enabled: selectedAccount !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => adminApi.nativeChatConversations({
      cursor: pageParam as string | undefined,
      employeeId: selectedAccount!.employeeId,
      accountId: selectedAccount!.accountId,
      channel,
      search
    }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined
  })
  const conversationItems: NativeChatConversationSummary[] = conversations.data?.pages.flatMap((page) => page.items) ?? []

  useEffect(() => {
    if (!conversationItems.length) {
      setSelectedId(null)
      return
    }
    if (selectedId === null || !conversationItems.some((item) => item.id === selectedId)) {
      setSelectedId(conversationItems[0].id)
    }
  }, [conversationItems, selectedId])

  const selected = conversationItems.find((item) => item.id === selectedId) ?? null
  const messages = useInfiniteQuery({
    queryKey: ['native-chat-record-messages', selectedId],
    enabled: selectedId !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => adminApi.nativeChatMessages(selectedId!, pageParam as string | undefined),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: selectedId !== null ? 10_000 : false
  })
  const aiAutomation = useQuery({
    queryKey: ['order-ai-automation-config'],
    queryFn: () => adminApi.orderAiAutomationConfig(),
    staleTime: 30_000
  })
  const page = messages.data?.pages[0]
  const totalMessages = page?.totalMessages ?? selected?.messageCount ?? 0
  const messageItems = useMemo(() => {
    const rows = messages.data?.pages.flatMap((item) => item.items) ?? []
    return rows.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
      || (a.sourceItemIndex ?? -1) - (b.sourceItemIndex ?? -1)
      || a.id - b.id)
  }, [messages.data])
  const loadedMessageCount = messageItems.reduce((count, message) => count + 1 + (message.children?.length ?? 0), 0)

  async function openAttachment(attachmentId: number, kind: string): Promise<void> {
    try {
      const { url } = await adminApi.nativeChatAttachmentUrl(attachmentId)
      if (kind === 'image') setLightbox(url)
      else if (kind === 'video') setVideoPreview(url)
      else window.open(url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
  }

  async function confirmMessageLink(message: NativeChatAdminMessage): Promise<void> {
    const applicationNo = window.prompt('请输入要关联的申领号', message.applicationNo ?? '')?.trim()
    if (!applicationNo) return
    const orderInput = window.prompt('如已确定具体订单，输入订单记录 ID；只关联申领号请留空', message.orderId?.toString() ?? '')
    if (orderInput === null) return
    const orderId = orderInput.trim() ? Number(orderInput.trim()) : null
    if (orderId !== null && (!Number.isSafeInteger(orderId) || orderId <= 0)) {
      window.alert('订单记录 ID 必须是正整数')
      return
    }
    try {
      await resolveMessageLink.mutateAsync({ messageId: message.id, applicationNo, orderId })
      await queryClient.invalidateQueries({ queryKey: ['native-chat-record-messages', selectedId] })
      await queryClient.invalidateQueries({ queryKey: ['native-chat-record-conversations'] })
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
  }

  async function clearSelectedAccountMessages(): Promise<void> {
    if (!selectedAccount) return
    const accountLabel = `${channelName(channel)} · ${selectedAccount.employeeName} · ${selectedAccount.accountId}`
    if (!window.confirm(`确定清除此账号已采集的全部消息和附件吗？\n\n${accountLabel}\n\n其他平台和账号的数据不会删除。此操作无法撤销。`)) return
    setClearMessagesResult(null)
    try {
      const result = await clearAccountMessages.mutateAsync({
        channel,
        employeeId: selectedAccount.employeeId,
        accountId: selectedAccount.accountId
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['native-chat-record-accounts', channel] }),
        queryClient.invalidateQueries({ queryKey: ['native-chat-record-conversations', channel] }),
        queryClient.invalidateQueries({ queryKey: ['native-chat-record-messages'] })
      ])
      setSelectedId(null)
      setAccountKey('')
      const cleanupNote = result.storageCleanupFailures > 0
        ? ` 对象存储中有 ${result.storageCleanupFailures} 个附件文件未能删除。`
        : ''
      setClearMessagesResult(`已清除 ${result.deletedMessages} 条消息、${result.deletedAttachments} 个附件。${cleanupNote}`)
    } catch (error) {
      setClearMessagesResult(`清除失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="微信与企微消息"
        subtitle="选择平台、账号和会话，查看已采集的消息及附件。"
        right={(
          <button
            className="rounded border border-line px-3 py-2 text-sm hover:bg-surface-2 disabled:opacity-50"
            disabled={accounts.isFetching || conversations.isFetching || (selectedId !== null && messages.isFetching)}
            onClick={() => {
              void accounts.refetch()
              if (selectedAccount) void conversations.refetch()
              if (selectedId !== null) void messages.refetch()
            }}
          >刷新记录</button>
        )}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded border border-line p-1" role="tablist" aria-label="消息渠道">
          {(['wechat', 'wxwork'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={channel === value}
              className={`rounded px-4 py-1.5 text-sm ${channel === value ? 'bg-accent-soft text-accent-strong font-medium' : 'text-fg-muted hover:bg-surface-2'}`}
              onClick={() => {
                setChannel(value)
                setAccountKey('')
                setSelectedId(null)
              }}
            >{channelName(value)}</button>
          ))}
        </div>
        <select
          className="min-w-64 rounded border border-line bg-surface px-3 py-2 text-sm"
          value={accountKey}
          onChange={(event) => {
            setAccountKey(event.target.value)
            setSelectedId(null)
          }}
          disabled={accounts.isLoading || accounts.isError || !accounts.data?.length}
        >
          <option value="">选择账号</option>
          {(accounts.data ?? []).map((account) => (
            <option key={`${account.employeeId}\u001f${account.accountId}`} value={`${account.employeeId}\u001f${account.accountId}`}>
              {account.employeeName}（寰宇员工 {account.employeeId}） · {account.accountId}
            </option>
          ))}
        </select>
        <form className="flex gap-2" onSubmit={(event) => {
          event.preventDefault()
          setSearch(searchInput.trim())
          setSelectedId(null)
        }}>
          <input
            className="w-64 rounded border border-line bg-surface px-3 py-2 text-sm"
            placeholder="搜索会话名称"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <button className="rounded border border-line px-3 py-2 text-sm hover:bg-surface-2" type="submit">搜索</button>
        </form>
        <span className="text-xs text-fg-subtle">已加载 {conversationItems.length} 个会话</span>
        {selectedAccount && (
          <button
            type="button"
            className="rounded border border-danger/40 px-3 py-2 text-sm text-danger hover:bg-danger/10 disabled:opacity-50"
            disabled={clearAccountMessages.isPending || accounts.isFetching || conversations.isFetching}
            onClick={() => void clearSelectedAccountMessages()}
          >{clearAccountMessages.isPending ? '正在清除…' : '清除此账号消息'}</button>
        )}
      </div>
      {clearMessagesResult && (
        <div className={`rounded border px-3 py-2 text-sm ${clearMessagesResult.startsWith('清除失败') ? 'border-danger/40 text-danger' : 'border-line text-fg-muted'}`}>
          {clearMessagesResult}
        </div>
      )}

      {accounts.isLoading ? <LoadingBlock /> : accounts.error ? (
        <ErrorBlock error={accounts.error} onRetry={() => void accounts.refetch()} />
      ) : accounts.data?.length === 0 ? (
        <Card className="p-2"><EmptyBlock label={`当前${channelName(channel)}暂无已入库的会话消息。`} /></Card>
      ) : accountKey === '' ? (
        <Card className="p-2"><EmptyBlock label="请先选择账号，再查看该账号中符合采集规则的会话和消息。" /></Card>
      ) : conversations.isLoading ? <LoadingBlock /> : conversations.error ? (
        <ErrorBlock error={conversations.error} onRetry={() => void conversations.refetch()} />
      ) : conversationItems.length === 0 ? (
        <Card className="p-2"><EmptyBlock label="还没有采集到会话。请先启动 Windows 客户端，并在“会话采集范围”中启用需要测试的会话。" /></Card>
      ) : (
        <div className="grid min-h-[65vh] grid-cols-1 gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <Card className="overflow-hidden">
            <div className="border-b border-line px-4 py-3 text-sm font-medium">会话</div>
            <div className="max-h-[60vh] overflow-y-auto">
              {conversationItems.map((conversation) => (
                <button
                  key={conversation.id}
                  className={`w-full border-b border-line px-4 py-3 text-left hover:bg-surface-2 ${selectedId === conversation.id ? 'bg-accent-soft' : ''}`}
                  onClick={() => setSelectedId(conversation.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{conversation.title || conversation.sourceConversationId}</span>
                    <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-fg-muted">{channelName(conversation.channel)}</span>
                  </div>
                  <div className="mt-1 text-xs text-fg-subtle">{conversation.employeeName} · {conversation.messageCount} 条消息 · {conversation.attachmentCount} 个附件</div>
                  <div className="mt-1 truncate text-xs text-fg-subtle" title={`采集账号：${conversation.accountId}`}>采集账号：{conversation.accountId}</div>
                  <div className="mt-1 truncate text-xs text-fg-subtle" title={applicationLinkLabel(conversation.applicationLinkStatus, conversation.applicationNo)}>
                    {applicationLinkLabel(conversation.applicationLinkStatus, conversation.applicationNo)}
                  </div>
                  <div className="mt-1 text-xs text-fg-subtle">最近消息：{conversation.lastMessageAt ? fmtTimeFull(conversation.lastMessageAt) : '暂无'}</div>
                </button>
              ))}
              <LoadMore
                hasNext={!!conversations.hasNextPage}
                loading={conversations.isFetchingNextPage}
                onLoad={() => void conversations.fetchNextPage()}
              />
            </div>
          </Card>

          <Card className="min-w-0 overflow-hidden">
            {selected ? (
              <>
                <div className="border-b border-line px-4 py-3">
                  <div className="font-medium">{selected.title || selected.sourceConversationId}</div>
                  <div className="mt-1 text-xs text-fg-subtle">
                    {channelName(selected.channel)} · {selected.employeeName} · 已入库 {loadedMessageCount} / {totalMessages} 条消息
                  </div>
                  <div className="mt-1 break-all text-xs text-fg-subtle">采集账号：{selected.accountId}</div>
                  <div className="mt-1 break-all text-xs text-fg-subtle">
                    {applicationLinkLabel(selected.applicationLinkStatus, selected.applicationNo)}
                    {selected.applicationCandidate ? `（识别到：${selected.applicationCandidate}）` : ''}
                  </div>
                </div>
                {messages.isLoading ? <LoadingBlock /> : messages.error ? (
                  <ErrorBlock error={messages.error} onRetry={() => void messages.refetch()} />
                ) : messageItems.length === 0 ? (
                  <EmptyBlock label="该会话还没有消息记录。" />
                ) : (
                  <div className="max-h-[60vh] overflow-y-auto px-4">
                    <LoadMore
                      hasNext={!!messages.hasNextPage}
                      loading={messages.isFetchingNextPage}
                      onLoad={() => void messages.fetchNextPage()}
                    />
                    <div className="space-y-3 py-2">
                      {messageItems.map((message) => <MessageCard key={message.id} message={message} onOpenAttachment={openAttachment} onConfirmBusinessLink={confirmMessageLink} imageAiEnabled={aiAutomation.data?.imageAiEnabled} imageAiAnalysisStartAt={aiAutomation.data?.imageAiAnalysisStartAt} />)}
                    </div>
                  </div>
                )}
              </>
            ) : <EmptyBlock label="选择左侧会话查看采集记录。" />}
          </Card>
        </div>
      )}

      <Lightbox src={lightbox} onClose={() => setLightbox(null)} />
      {videoPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6" onClick={() => setVideoPreview(null)}>
          <video
            src={videoPreview}
            controls
            autoPlay
            className="max-h-full max-w-full"
            onClick={(event) => event.stopPropagation()}
          />
          <button
            onClick={() => setVideoPreview(null)}
            className="absolute right-4 top-4 text-2xl leading-none text-white/80 hover:text-white"
            aria-label="关闭视频"
          >✕</button>
        </div>
      )}
    </div>
  )
}

function MessageCard({
  message,
  onOpenAttachment,
  onConfirmBusinessLink,
  imageAiEnabled,
  imageAiAnalysisStartAt,
  rootReceivedAt,
  nested = false
}: {
  message: NativeChatAdminMessage
  onOpenAttachment: (attachmentId: number, kind: string) => Promise<void>
  onConfirmBusinessLink: (message: NativeChatAdminMessage) => Promise<void>
  imageAiEnabled: boolean | undefined
  imageAiAnalysisStartAt: string | undefined
  rootReceivedAt?: string
  nested?: boolean
}): React.JSX.Element {
  const merged = message.kind === 'merged'
  const wechatNote = merged && message.sourceMetadata?.wechatAppMessageType === '24'
  const [rawStructureExpanded, setRawStructureExpanded] = useState(false)
  const rawStructure = {
    sourceTypeCode: message.sourceTypeCode,
    text: message.text,
    sourceMetadata: message.sourceMetadata,
    attachments: message.attachments.map((attachment) => ({
      kind: attachment.kind,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
      state: attachment.state,
      sourceMetadata: attachment.sourceMetadata
    }))
  }
  return (
    <article className={`rounded-lg border border-line p-3 ${nested ? 'bg-surface-2/40' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-subtle">
        <span>{fmtTimeFull(message.occurredAt)}</span>
        {!nested && <span className="rounded bg-surface-2 px-1.5 py-0.5">{directionName(message.direction)}</span>}
        <span className="rounded bg-surface-2 px-1.5 py-0.5">{wechatNote ? '微信笔记' : kindName(message.kind)}</span>
        {message.senderName && <span>发送人：{message.senderName}</span>}
        {nested && message.sourceItemIndex !== null && <span>第 {message.sourceItemIndex + 1} 项</span>}
      </div>
      {(messageBusinessLinkLabel(message) || message.applicationLinkStatus !== 'matched') && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          <span>{messageBusinessLinkLabel(message) ?? '业务归属待确认'}</span>
          {message.applicationLinkStatus !== 'matched' && (
            <button type="button" className="text-accent-strong underline" onClick={() => void onConfirmBusinessLink(message)}>确认消息归属</button>
          )}
        </div>
      )}
      {merged ? (
        <div className="mt-2 text-sm font-medium">
          {message.children?.length
            ? `${wechatNote ? '微信笔记' : '合并聊天记录'}（${message.children.length} 条内容）`
            : `${wechatNote ? '微信笔记' : '合并聊天记录'}内容尚未解析`}
        </div>
      ) : message.text && <div className="mt-2 whitespace-pre-wrap break-words text-sm">{message.text}</div>}
      {merged && message.children && message.children.length > 0 && (
        <div className="mt-3 space-y-2 border-l-2 border-line pl-3">
          {message.children.map((child) => (
            <MessageCard key={child.id} message={child} onOpenAttachment={onOpenAttachment} onConfirmBusinessLink={onConfirmBusinessLink} imageAiEnabled={imageAiEnabled} imageAiAnalysisStartAt={imageAiAnalysisStartAt} rootReceivedAt={rootReceivedAt ?? message.occurredAt} nested />
          ))}
        </div>
      )}
      {message.attachments.length > 0 && (
        <div className="mt-3 space-y-2">
          {message.attachments.map((attachment) => (
            <div key={attachment.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded bg-surface-2 px-3 py-2 text-xs">
              <span className="font-medium">{attachment.fileName || kindName(attachment.kind)}</span>
              {attachment.applicationLinkStatus === 'matched' && attachment.applicationNo && (
                <span className="text-accent-strong">独立素材 · {attachment.applicationNo}{attachment.orderId !== null ? ` · 订单记录 ${attachment.orderId}` : ''}</span>
              )}
              {attachment.applicationLinkStatus === 'conflict' && <span className="text-warning">素材归属待核对</span>}
              <span className={attachment.kind === 'image' && attachment.sourceMetadata?.nonThumbnailState !== 'available'
                ? 'text-warning'
                : attachment.availableInStorage ? 'text-success' : 'text-warning'}>
                {attachment.sourceMetadata?.resolutionState === 'upload_size_exceeded'
                  ? '文件超过 30 MB，未上传'
                  : attachment.kind === 'image' && attachment.sourceMetadata?.nonThumbnailState === 'available'
                  ? '高清图片已获取'
                  : attachment.kind === 'image' && attachment.sourceMetadata?.nonThumbnailState === 'pending' && attachment.sourceMetadata?.rendition === 'thumbnail'
                  ? '已采集缩略图，清晰图片待获取'
                  : attachment.kind === 'image' && attachment.sourceMetadata?.nonThumbnailState === 'pending'
                    ? attachment.sourceMetadata?.rendition === 'unverified'
                      ? '图片已采集，清晰度待确认'
                      : '图片尚未下载，等待获取'
                  : attachment.kind === 'video' && attachment.sourceMetadata?.resolutionState === 'local_record_video_not_matched'
                    ? '本机视频尚未匹配到这条消息'
                  : attachment.kind === 'video' && attachment.sourceMetadata?.resolutionState === 'missing_resource_id'
                    ? '尚未关联到本机视频文件'
                  : attachment.kind === 'video' && attachment.sourceMetadata?.resolutionState === 'resource_file_not_found'
                    ? '未找到这条视频对应的本机文件'
                  : attachment.sourceMetadata?.resolutionState === 'ambiguous_resource_metadata'
                    ? '微信资源记录不一致，附件未匹配'
                  : attachment.sourceMetadata?.resolutionState === 'different_local_files'
                    ? '本机找到多个内容不同的候选文件，未自动选择'
                  : attachment.sourceMetadata?.resolutionState === 'invalid_resource_metadata'
                    ? '微信文件信息无法解析'
                  : attachment.sourceMetadata?.resolutionState === 'size_mismatch'
                    ? '文件暂未匹配，继续查找'
                  : attachmentStateName(attachment.state, attachment.availableInStorage)}
              </span>
              <span className="text-fg-subtle">{formatBytes(attachment.byteSize)}</span>
              <AttachmentMatchCandidates sourceMetadata={attachment.sourceMetadata} />
              {attachment.availableInStorage && (
                <button
                  className="text-accent-strong underline"
                  onClick={() => void onOpenAttachment(attachment.id, attachment.kind)}
                >{attachment.kind === 'image' ? '查看图片' : attachment.kind === 'video' ? '播放视频' : '打开文件'}</button>
              )}
              <ImageAnalysisLog attachment={attachment} enabled={imageAiEnabled} receivedAt={rootReceivedAt ?? message.occurredAt} analysisStartAt={imageAiAnalysisStartAt} />
            </div>
          ))}
        </div>
      )}
      {!message.text && message.attachments.length === 0 && <div className="mt-2 text-sm text-fg-subtle">{kindName(message.kind)}消息（无文字或附件内容）</div>}
      {(message.sourceTypeCode || message.sourceMetadata || message.attachments.some((attachment) => attachment.sourceMetadata)) && (
        <div className="mt-3 border-t border-line pt-2">
          <button
            type="button"
            className="text-xs text-accent-strong underline"
            aria-expanded={rawStructureExpanded}
            onClick={() => setRawStructureExpanded((expanded) => !expanded)}
          >{rawStructureExpanded ? '收起原始结构' : '查看原始结构'}</button>
          {rawStructureExpanded && (
            <pre className="mt-2 max-h-96 overflow-auto rounded bg-surface-2 p-3 text-xs leading-relaxed whitespace-pre-wrap break-all">
              {JSON.stringify(rawStructure, null, 2)}
            </pre>
          )}
        </div>
      )}
    </article>
  )
}
