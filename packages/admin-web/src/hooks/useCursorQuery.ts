import { useInfiniteQuery } from '@tanstack/react-query'
import type { CursorPage } from '../api/types'

// 封装基于 nextCursor 的 keyset 分页。fetcher 接收 cursor（首页为 undefined）。
export function useCursorQuery<T>(
  key: unknown[],
  fetcher: (cursor?: string) => Promise<CursorPage<T>>,
  opts: { refetchInterval?: number } = {}
) {
  const query = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetcher(pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: opts.refetchInterval
  })

  // 摊平所有页的 items
  const items: T[] = query.data?.pages.flatMap((p) => p.items) ?? []
  return { ...query, items }
}
