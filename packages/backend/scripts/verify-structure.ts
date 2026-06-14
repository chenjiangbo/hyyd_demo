/* 验证 messageStructure：模拟一帧企微截图的 OCR 词块（含侧栏/成员面板干扰 + 气泡颜色样本），
 * 检查 列检测排除侧栏/成员面板、按颜色判 self/other、居中时间行判 system。
 * 运行：cd packages/backend && npx tsx scripts/verify-structure.ts */
import { structureMessages, type StructBlock, type StructColor } from '../src/lib/messageStructure.js'

const GREEN: StructColor = { r: 149, g: 236, b: 105 } // 自己的绿气泡（高饱和）
const GRAY: StructColor = { r: 240, g: 240, b: 240 } // 对方的灰白气泡（低饱和）

// 把一行文字拆成"逐字词块"（模拟 Windows OCR），每块带同一颜色样本
function line(text: string, x0: number, y: number, charW: number, color: StructColor | null): StructBlock[] {
  return [...text].map((ch, i) => ({
    text: ch,
    bbox: { x: x0 + i * charW, y, width: charW - 4, height: 24 },
    colorSample: color
  }))
}

const blocks: StructBlock[] = [
  // —— 左侧会话列表（应被排除）——
  ...line('会话甲', 20, 100, 20, null),
  ...line('会话乙', 20, 180, 20, null),
  ...line('会话丙', 20, 260, 20, null),
  ...line('会话丁', 20, 340, 20, null),
  ...line('会话戊', 20, 420, 20, null),
  ...line('会话己', 20, 500, 20, null),
  // —— 右侧群成员面板（应被排除）——
  ...line('成员A', 1220, 100, 22, null),
  ...line('成员B', 1220, 180, 22, null),
  ...line('成员C', 1220, 260, 22, null),
  ...line('成员D', 1220, 340, 22, null),
  ...line('成员E', 1220, 420, 22, null),
  // —— 聊天区 ——
  ...line('14:32', 730, 200, 12, null), // 居中时间 → system
  ...line('你好请问', 420, 300, 30, GRAY), // 对方
  ...line('好的我帮您安排', 820, 400, 34, GREEN), // 自己（靠右、绿）
  ...line('我父亲63岁以前抽烟现在戒了想去上海或北京', 420, 500, 22, GRAY) // 对方长消息（横跨宽）
]

const msgs = structureMessages({ channel: 'wxwork', width: 1343, height: 860, blocks })

console.log('结构化结果：')
for (const m of msgs) console.log(`  [${m.speaker}] ${m.text.replace(/\n/g, ' ')}`)

// 断言
const speakers = msgs.map((m) => m.speaker)
const ok =
  msgs.length === 4 &&
  speakers.join(',') === 'system,other,self,other' &&
  !msgs.some((m) => /会话|成员/.test(m.text)) // 侧栏/成员面板未混入
console.log(ok ? '\n✅ 通过：列检测排除侧栏/成员面板，self/other/system 判定正确' : '\n❌ 不符合预期')
process.exit(ok ? 0 : 1)
