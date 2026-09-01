import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi } from '../api/client'
import { Card, EmptyBlock, ErrorBlock, LoadingBlock, PageHeader } from '../components/ui'
import { Lightbox } from '../components/Lightbox'
import { fmtTimeFull } from '../lib/format'

function channelLabel(channel: string): string {
  return channel === 'wxwork' ? '企微' : channel === 'wechat' ? '微信' : channel
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
}

export default function CaptureDiagnosticImagesPage(): React.JSX.Element {
  const client = useQueryClient()
  const [lightbox, setLightbox] = useState<string | null>(null)
  const q = useQuery({
    queryKey: ['capture-diagnostic-images'],
    queryFn: () => adminApi.captureDiagnosticImages(),
    refetchInterval: 30_000
  })

  const remove = async (id: string): Promise<void> => {
    if (!window.confirm('确定删除这张采集诊断图片吗？')) return
    await adminApi.deleteCaptureDiagnosticImage(id)
    await client.invalidateQueries({ queryKey: ['capture-diagnostic-images'] })
    if (lightbox) setLightbox(null)
  }

  return (
    <div>
      <PageHeader title="采集诊断图片" subtitle="查看微信和企微采集时上传的现场截图；图片由管理员手动删除" />
      {q.isLoading ? <LoadingBlock /> : q.error ? <ErrorBlock error={q.error} onRetry={() => void q.refetch()} /> : !q.data?.length ? (
        <EmptyBlock label="暂无诊断图片" />
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
          {q.data.map((item) => (
            <Card key={item.objectKey} className="p-3 flex gap-3">
              {item.imageUrl ? (
                <img
                  src={item.imageUrl}
                  alt={`${item.applicationNo} ${item.conversationName}`}
                  className="w-44 h-32 object-contain bg-surface-2 border border-line rounded-md cursor-zoom-in shrink-0"
                  onClick={() => setLightbox(item.imageUrl)}
                />
              ) : <div className="w-44 h-32 flex items-center justify-center bg-surface-2 border border-line rounded-md text-xs text-fg-subtle shrink-0">图片不可用</div>}
              <div className="min-w-0 flex-1 text-sm">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-semibold truncate">{item.applicationNo}</span>
                  <span className="text-xs text-fg-muted">{channelLabel(item.channel)}</span>
                </div>
                <div className="truncate text-fg">{item.conversationName}</div>
                <div className="text-xs text-fg-muted mt-2">截图时间：{fmtTimeFull(item.capturedAt)}</div>
                <div className="text-xs text-fg-muted mt-1">员工：{item.employee.name} · {sizeLabel(item.byteSize)}</div>
                <button onClick={() => void remove(item.objectKey)} className="mt-3 px-2.5 py-1 text-xs rounded border border-danger/40 text-danger hover:bg-danger/10">删除图片</button>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Lightbox src={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}
