export interface HuanyuFixedDictionaryOption {
  id: string
  name: string
}

// 寰宇订单固定字典。仅在后端维护，前端不可新增、修改或删除选项。
const BOOKING_CHANNEL_TYPES: readonly HuanyuFixedDictionaryOption[] = [
  { id: '1', name: 'BD' },
  { id: '2', name: '公共' },
  { id: '3', name: '无' }
]

const DOCUMENT_TYPES: readonly HuanyuFixedDictionaryOption[] = [
  { id: '身份证', name: '身份证' },
  { id: '护照', name: '护照' },
  { id: '军人证', name: '军人证' },
  { id: '儿童身份证', name: '儿童身份证' },
  { id: '港澳居民通行证', name: '港澳居民通行证' },
  { id: '台湾居民通行证', name: '台湾居民通行证' },
  { id: '外国人居留证', name: '外国人居留证' },
  { id: '其他', name: '其他' }
]

const EXPERT_LEVELS: readonly HuanyuFixedDictionaryOption[] = [
  { id: '知名专家', name: '知名专家' },
  { id: '主任医师', name: '主任医师' },
  { id: '副主任医师', name: '副主任医师' },
  { id: '主治医师', name: '主治医师' },
  { id: '住院医师', name: '住院医师' }
]

export function huanyuBookingChannelTypes(): HuanyuFixedDictionaryOption[] {
  return BOOKING_CHANNEL_TYPES.map((item) => ({ ...item }))
}

export function huanyuDocumentTypes(): HuanyuFixedDictionaryOption[] {
  return DOCUMENT_TYPES.map((item) => ({ ...item }))
}

export function huanyuExpertLevels(rawSearch: unknown): HuanyuFixedDictionaryOption[] {
  const search = typeof rawSearch === 'string' ? rawSearch.trim() : ''
  return EXPERT_LEVELS
    .filter((item) => !search || item.name.includes(search))
    .map((item) => ({ ...item }))
}
