import { visionChat } from '../llm/gatewayClient.js'

export type UnderstoodImageType =
  | '挂号凭证' | '出行订单' | '导航截图' | '医院小程序' | '医院公众号'
  | '缴费或检查材料' | '聊天截图' | '其他' | '无法判断'

export type UnderstoodImage = {
  imageType: UnderstoodImageType
  typeDescription: string
  description: string
  visibleText: string
  visibleFields: Array<{ label: string; value: string }>
  model: string
}

export const IMAGE_UNDERSTANDING_PROMPT = [
  '你是寰宇医疗服务的图片内容识别助手。请识别图片是什么图片，并整理图片中看得见的内容文字，以便程序能够根据关键字段搜索业务记录。只整理图片实际显示的内容，不自行推断、补全或扩展其他数据项。图片中不会出现寰宇或泰康系统使用的申领号；不要把图片里的挂号编号、预约编号或其他号码误认为申领号。',
  '图片类型可能包括：挂号凭证、滴滴等出行订单、导航截图、医院小程序或公众号页面、缴费或检查材料、聊天截图等。如果图片不属于这些类型，请基于图片内容说明它是什么；如果确实无法判断，说明无法判断。',
  '识别图片类型时，请结合整张图片的版式、主要内容、文字之间的关系和页面状态判断。不要只根据是否出现某个固定词语分类。例如，聊天截图中出现“挂号”一词，不代表这张图就是挂号凭证。',
  '挂号凭证可能通过图片整体内容表达挂号已经完成、预约成功或已经确定按时看诊等含义。医院、科室、医生或患者姓名可能没有显示；姓名也可能只显示最后一个字。只根据图片中实际可见的内容判断和记录，不因某项缺失就自行否定其他可见信息。',
  '如果是导航截图，请说明这是导航页面，并整理可见的起点、目的地、路线和距离等内容。',
  '如果是小程序或公众号页面，请描述可辨认的小程序或公众号名称、页面内容和可见文字；不要推断客户打开页面的意图。',
  '如果是滴滴等出行订单，请整理图片中可见的订单文字和字段，包括但不限于订单状态、时间、起点、终点、公里数、价格和联系电话。仅记录看得见的内容，不要从页面类型推断行程已经完成。',
  '所有图片都要给出主要类型和简短、客观的内容描述。无法判断类型时，类型写“无法判断”，并说明图片中仍能看清的内容。',
  '只返回 JSON：{"imageType":"挂号凭证|出行订单|导航截图|医院小程序|医院公众号|缴费或检查材料|聊天截图|其他|无法判断","typeDescription":"...","description":"...","visibleText":"...","visibleFields":[{"label":"...","value":"..."}]}。visibleFields 只列图片实际显示且可读的字段，不要补不存在的字段。'
].join('\n')

const ALLOWED_IMAGE_TYPES = new Set<UnderstoodImageType>([
  '挂号凭证', '出行订单', '导航截图', '医院小程序', '医院公众号', '缴费或检查材料', '聊天截图', '其他', '无法判断'
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`图片识别结果缺少字符串字段 ${name}`)
  return value.trim()
}

export async function understandImage(imageDataUrl: string): Promise<UnderstoodImage> {
  const response = await visionChat(
    '你是寰宇医疗服务的图片内容识别助手。严格按用户指令识别图片并返回规定 JSON。',
    IMAGE_UNDERSTANDING_PROMPT,
    imageDataUrl,
    { temperature: 0 }
  )
  const cleaned = response.content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('图片识别模型没有返回 JSON 对象')
  const parsed = asRecord(JSON.parse(cleaned.slice(start, end + 1)))
  if (!parsed) throw new Error('图片识别模型返回的 JSON 结构无效')
  if (typeof parsed.imageType !== 'string' || !ALLOWED_IMAGE_TYPES.has(parsed.imageType as UnderstoodImageType)) {
    throw new Error('图片识别结果 imageType 不在允许类型内')
  }
  if (!Array.isArray(parsed.visibleFields)) throw new Error('图片识别结果 visibleFields 必须是数组')
  const visibleFields = parsed.visibleFields.map((value, index) => {
    const field = asRecord(value)
    if (!field) throw new Error(`图片识别结果 visibleFields[${index}] 不是对象`)
    return { label: requiredString(field.label, `visibleFields[${index}].label`), value: requiredString(field.value, `visibleFields[${index}].value`) }
  })
  return {
    imageType: parsed.imageType as UnderstoodImageType,
    typeDescription: requiredString(parsed.typeDescription, 'typeDescription'),
    description: requiredString(parsed.description, 'description'),
    visibleText: requiredString(parsed.visibleText, 'visibleText'),
    visibleFields,
    model: response.model
  }
}
