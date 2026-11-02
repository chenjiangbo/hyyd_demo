/** Locate complete WXGF image partitions using their length-prefixed HEVC streams. */
export function wxgfImagePartition(data: Buffer): Buffer {
  if (data.length < 15 || data.subarray(0, 4).toString('ascii') !== 'wxgf') throw new Error('微信图片不是有效的 WXGF 格式')
  const headerLength = data[4]
  if (headerLength >= data.length) throw new Error('微信图片头部长度无效')
  for (const marker of [Buffer.from([0, 0, 0, 1]), Buffer.from([0, 0, 1])]) {
    const partitions: Array<{ offset: number; size: number }> = []
    let position = headerLength
    while (position < data.length) {
      const offset = data.indexOf(marker, position)
      if (offset < 0) break
      if (offset < 4) { position = offset + 1; continue }
      const size = data.readUInt32BE(offset - 4)
      if (size === 0 || offset + size > data.length) { position = offset + 1; continue }
      partitions.push({ offset, size })
      position = offset + size
    }
    if (partitions.length) {
      const largest = partitions.reduce((best, current) => current.size > best.size ? current : best)
      if (partitions.length > 1 && largest.size / data.length < 0.6) throw new Error('暂不支持转换多帧微信图片')
      return data.subarray(largest.offset, largest.offset + largest.size)
    }
  }
  throw new Error('微信图片中未找到完整图像数据')
}
