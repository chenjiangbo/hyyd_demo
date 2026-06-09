// 游标分页的"加载更多"按钮。
export function LoadMore({
  hasNext,
  loading,
  onLoad
}: {
  hasNext: boolean
  loading: boolean
  onLoad: () => void
}): React.JSX.Element | null {
  if (!hasNext) return null
  return (
    <div className="py-4 text-center">
      <button
        onClick={onLoad}
        disabled={loading}
        className="text-sm px-4 py-1.5 rounded-md border border-line text-fg-muted hover:bg-surface-2 disabled:opacity-50"
      >
        {loading ? '加载中…' : '加载更多'}
      </button>
    </div>
  )
}
