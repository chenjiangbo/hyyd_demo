const fs = require('fs')
const { execFileSync, spawnSync } = require('child_process')
const path = require('path')

const input = process.argv[2] || 'debug/20260616-073944-751-wechat-3abc8532037e.png'
const output = process.argv[3] || 'debug/bubble-candidates.png'
const width = 896
const height = 631
const chat = { x0: 290, y0: 78, x1: 884, y1: 424 }

const raw = execFileSync('magick', [input, '-depth', '8', 'rgba:-'], { maxBuffer: width * height * 4 + 1024 })
if (raw.length !== width * height * 4) {
  throw new Error(`unexpected raw size ${raw.length}`)
}

function idx(x, y) { return (y * width + x) * 4 }
function px(x, y) {
  const i = idx(x, y)
  return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]]
}
function isBubbleFill(x, y) {
  const [r, g, b, a] = px(x, y)
  if (a < 200) return false
  // WeChat left bubbles and file cards in this screenshot are around rgb(238,238,240).
  const neutral = Math.abs(r - g) <= 4 && Math.abs(g - b) <= 5
  const lightGrayBubble = neutral && r >= 228 && r <= 246 && g >= 228 && g <= 246 && b >= 228 && b <= 247
  // Self bubbles vary by theme; keep a broad green/blue bucket for later samples.
  const coloredBubble = (g > 175 && r < 210 && b < 210) || (b > 175 && r < 210 && g < 230)
  return lightGrayBubble || coloredBubble
}

const mask = new Uint8Array(width * height)
for (let y = chat.y0; y < chat.y1; y++) {
  for (let x = chat.x0; x < chat.x1; x++) {
    if (isBubbleFill(x, y)) mask[y * width + x] = 1
  }
}

// Close text holes and small anti-aliased gaps.
function dilate(src, radius) {
  const dst = new Uint8Array(src.length)
  for (let y = chat.y0; y < chat.y1; y++) {
    for (let x = chat.x0; x < chat.x1; x++) {
      let on = false
      for (let dy = -radius; dy <= radius && !on; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx, yy = y + dy
          if (xx < chat.x0 || xx >= chat.x1 || yy < chat.y0 || yy >= chat.y1) continue
          if (src[yy * width + xx]) { on = true; break }
        }
      }
      if (on) dst[y * width + x] = 1
    }
  }
  return dst
}
function erode(src, radius) {
  const dst = new Uint8Array(src.length)
  for (let y = chat.y0; y < chat.y1; y++) {
    for (let x = chat.x0; x < chat.x1; x++) {
      let on = true
      for (let dy = -radius; dy <= radius && on; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx, yy = y + dy
          if (xx < chat.x0 || xx >= chat.x1 || yy < chat.y0 || yy >= chat.y1 || !src[yy * width + xx]) {
            on = false; break
          }
        }
      }
      if (on) dst[y * width + x] = 1
    }
  }
  return dst
}

let closed = dilate(mask, 3)
closed = erode(closed, 2)

const seen = new Uint8Array(width * height)
const comps = []
const qx = []
const qy = []
for (let y = chat.y0; y < chat.y1; y++) {
  for (let x = chat.x0; x < chat.x1; x++) {
    const start = y * width + x
    if (!closed[start] || seen[start]) continue
    let minX = x, maxX = x, minY = y, maxY = y, n = 0
    const rowCounts = new Map()
    qx.length = 0; qy.length = 0
    qx.push(x); qy.push(y); seen[start] = 1
    for (let qi = 0; qi < qx.length; qi++) {
      const cx = qx[qi], cy = qy[qi]
      n++
      rowCounts.set(cy, (rowCounts.get(cy) || 0) + 1)
      if (cx < minX) minX = cx
      if (cx > maxX) maxX = cx
      if (cy < minY) minY = cy
      if (cy > maxY) maxY = cy
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = cx + dx, ny = cy + dy
        if (nx < chat.x0 || nx >= chat.x1 || ny < chat.y0 || ny >= chat.y1) continue
        const ni = ny * width + nx
        if (!closed[ni] || seen[ni]) continue
        seen[ni] = 1
        qx.push(nx); qy.push(ny)
      }
    }
    const w = maxX - minX + 1
    const h = maxY - minY + 1
    if (n >= 120 && w >= 18 && h >= 12) {
      const counts = [...rowCounts.entries()].sort((a, b) => a[0] - b[0])
      const maxRow = Math.max(...counts.map(([, count]) => count))
      const rowThreshold = Math.max(24, maxRow * 0.28)
      const solidRows = counts.filter(([, count]) => count >= rowThreshold).map(([yy]) => yy)
      if (solidRows.length > 0) {
        minY = solidRows[0]
        maxY = solidRows[solidRows.length - 1]
      }
      comps.push({ x: minX, y: minY, w, h: maxY - minY + 1, area: n, maxRow })
    }
  }
}

const filtered = comps
  .filter(c => c.w <= 360 && c.h <= 120)
  .filter(c => !(c.w <= 45 && c.h <= 45))
  .sort((a, b) => a.y - b.y || a.x - b.x)

const ocr = [
  { text: '□', x: 810, y: 5, w: 22, h: 20 },
  { text: '×', x: 855, y: 4, w: 20, h: 21 },
  { text: 'Q 搜索', x: 80, y: 39, w: 61, h: 29 },
  { text: '田', x: 249, y: 43, w: 25, h: 24 },
  { text: '北京致简高企复审审计沟通群(7)', x: 301, y: 42, w: 215, h: 23 },
  { text: '…', x: 841, y: 45, w: 25, h: 17 },
  { text: '4C1F-87FA-7616-BB42', x: 118, y: 84, w: 142, h: 28 },
  { text: '1L.u', x: 248, y: 72, w: 32, h: 16 },
  { text: '28.8K', x: 363, y: 75, w: 45, h: 25 },
  { text: '89', x: 34, y: 94, w: 30, h: 22 },
  { text: '·微信电脑版', x: 360, y: 105, w: 96, h: 32 },
  { text: '北京致简高企..', x: 118, y: 129, w: 125, h: 26 },
  { text: '专利高新审计商标-飞鱼：…', x: 118, y: 150, w: 165, h: 26 },
  { text: '12:02', x: 245, y: 132, w: 38, h: 21 },
  { text: '牛儿', x: 353, y: 145, w: 37, h: 24 },
  { text: '北京致简RD.docx', x: 363, y: 180, w: 123, h: 25 },
  { text: '致简人事和财务.', x: 121, y: 196, w: 119, h: 22 },
  { text: '11:46', x: 244, y: 198, w: 39, h: 20 },
  { text: '20.2K', x: 361, y: 201, w: 49, h: 28 },
  { text: 'W', x: 560, y: 193, w: 29, h: 26 },
  { text: '袁源：好的🙏', x: 120, y: 216, w: 95, h: 24 },
  { text: '微信电脑版', x: 360, y: 233, w: 96, h: 32 },
  { text: '正', x: 101, y: 250, w: 30, h: 25 },
  { text: '[15条] 已支付¥26.00', x: 118, y: 278, w: 125, h: 27 },
  { text: '微信支付', x: 118, y: 255, w: 71, h: 33 },
  { text: '11:41', x: 246, y: 262, w: 34, h: 20 },
  { text: '牛儿', x: 350, y: 271, w: 43, h: 31 },
  { text: '8', x: 21, y: 290, w: 32, h: 28 },
  { text: '@专利高新审计商标-飞鱼RD PS已经好了', x: 365, y: 302, w: 287, h: 28 },
  { text: '吕宾', x: 117, y: 321, w: 45, h: 32 },
  { text: '10:48', x: 245, y: 327, w: 38, h: 21 },
  { text: '好的', x: 116, y: 344, w: 41, h: 29 },
  { text: '专利高新审计商标-飞鱼', x: 355, y: 352, w: 144, h: 22 },
  { text: '好的', x: 363, y: 379, w: 44, h: 28 },
  { text: '张敏华 (农信)', x: 118, y: 390, w: 101, h: 26 },
  { text: '10:38', x: 246, y: 392, w: 37, h: 20 },
  { text: '最晚说7月6 就要入职。…', x: 120, y: 408, w: 136, h: 25 },
  { text: '齐超', x: 118, y: 453, w: 42, h: 28 },
  { text: '10:15', x: 246, y: 458, w: 37, h: 20 },
  { text: '[动画表情', x: 121, y: 477, w: 65, h: 23 },
  { text: '星巴……', x: 124, y: 518, w: 67, h: 28 },
  { text: '@星…', x: 188, y: 520, w: 55, h: 25 },
  { text: '09:20', x: 244, y: 523, w: 39, h: 20 },
  { text: '[小程序]¥24.3起喝新….', x: 120, y: 540, w: 136, h: 25 },
  { text: '草莓班', x: 137, y: 586, w: 54, h: 24 },
  { text: '08:29', x: 245, y: 586, w: 37, h: 22 },
  { text: '日', x: 375, y: 575, w: 32, h: 25 },
  { text: '发送', x: 819, y: 577, w: 32, h: 21 },
]

function center(o) { return { x: o.x + o.w / 2, y: o.y + o.h / 2 } }
function inside(c, o, pad = 3) {
  const p = center(o)
  return p.x >= c.x - pad && p.x <= c.x + c.w + pad && p.y >= c.y - pad && p.y <= c.y + c.h + pad
}
function overlapX(a, b) {
  return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
}
function isInputNoise(o) {
  const send = ocr.find(x => x.text === '发送')
  if (!send) return false
  return Math.abs(center(o).y - center(send).y) <= 22 || o.y > send.y
}
function isSystemLike(o) {
  const p = center(o)
  const chatCenter = (chat.x0 + chat.x1) / 2
  return Math.abs(p.x - chatCenter) <= 70 && o.w <= 170 && !filtered.some(b => inside(b, o))
}
function findSenderForBubble(b) {
  return ocr
    .filter(o => !isInputNoise(o))
    .filter(o => !filtered.some(bb => inside(bb, o)))
    .filter(o => o.y + o.h <= b.y + 10)
    .filter(o => b.y - (o.y + o.h) <= 48)
    .filter(o => o.x >= b.x - 12 && o.x <= b.x + 60)
    .filter(o => center(o).x < (chat.x0 + chat.x1) / 2)
    .filter(o => !/微信电脑版|企业微信/.test(o.text))
    .sort((a, c) => (c.y + c.h) - (a.y + a.h))[0] || null
}

const assignments = filtered.map((b, i) => {
  let lines = ocr.filter(o => !isInputNoise(o)).filter(o => inside(b, o)).sort((a, c) => a.y - c.y || a.x - c.x)
  let sender = findSenderForBubble(b)
  const topInside = lines[0]
  if (!sender && topInside && lines.length >= 2 && topInside.y < b.y + 18 && topInside.text.length <= 20 && !/微信电脑版|企业微信/.test(topInside.text)) {
    sender = topInside
    lines = lines.slice(1)
  }
  return {
    id: i + 1,
    box: b,
    speaker: center(b).x > (chat.x0 + chat.x1) / 2 ? 'self' : 'other',
    sender: sender?.text ?? null,
    text: lines.map(o => o.text),
  }
})

const system = ocr
  .filter(o => !isInputNoise(o))
  .filter(isSystemLike)
  .map(o => o.text)

fs.writeFileSync(output.replace(/\.png$/i, '.assignments.json'), JSON.stringify({ bubbles: assignments, system }, null, 2))

const jsonOutput = output.replace(/\.png$/i, '.json')
fs.writeFileSync(jsonOutput, JSON.stringify(filtered, null, 2))

const drawArgs = [input]
for (const c of filtered) {
  drawArgs.push('-fill', 'none', '-stroke', 'red', '-strokewidth', '2', '-draw', `rectangle ${c.x},${c.y} ${c.x + c.w},${c.y + c.h}`)
}
drawArgs.push(output)
const res = spawnSync('magick', drawArgs, { stdio: 'inherit' })
if (res.status !== 0) process.exit(res.status ?? 1)
console.log(`wrote ${output} and ${jsonOutput}`)
