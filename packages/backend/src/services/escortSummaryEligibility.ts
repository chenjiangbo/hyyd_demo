import { XMLParser, XMLValidator } from 'fast-xml-parser'

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: false })
const summaryKeyword = /陪诊(?:小结|总结|过程)/
const visibleTags = new Set(['datadesc', 'content', 'des', 'title'])

/** Return business text from a plain message or a WeChat XML envelope. */
export function escortSummaryVisibleText(content: string): string {
  const header = content.match(/^(?:[^\n]{1,200}:\s*)?(?:(?:<\?xml[^>]*\?>)\s*)?<msg(?:\s|>)/i)
  if (!header) return content
  const start = content.indexOf('<', 0)
  const xml = content.slice(start)
  const parts: string[] = []
  const visit = (value: unknown, key = ''): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item, key); return }
    if (typeof value === 'string') {
      if (key.toLowerCase() === 'recorditem' && value.trim().startsWith('<')) {
        if (XMLValidator.validate(value) !== true) throw new Error('微信笔记内容不是有效 XML')
        visit(parser.parse(value))
      } else if (visibleTags.has(key.toLowerCase()) && value.trim()) parts.push(value)
      return
    }
    if (value && typeof value === 'object') for (const [childKey, item] of Object.entries(value as Record<string, unknown>)) visit(item, childKey)
  }
  if (XMLValidator.validate(xml) !== true) throw new Error('微信消息内容不是有效 XML')
  visit(parser.parse(xml))
  // Previews can repeat text already present in the full note.
  const unique = [...new Set(parts)].filter((part, index, all) => !all.some((other, j) => index !== j && other.length > part.length && other.includes(part)))
  return unique.join('\n')
}

export function isEscortSummaryEligibleText(content: string): boolean {
  if (!summaryKeyword.test(content) && !/&#(?:x[0-9a-f]+|[0-9]+);/i.test(content)) return false
  const text = escortSummaryVisibleText(content)
  return summaryKeyword.test(text) && Array.from(text.replace(/\s/gu, '')).length > 80
}
