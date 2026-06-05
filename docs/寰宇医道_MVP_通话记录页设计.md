# 通话记录页设计

> **状态**：草案 v0.1，待 review  
> **关联**：[通话录音转写设计](./寰宇医道_MVP_通话录音转写设计.md)  
> **日期**：2026-05-27

## 1. 目标

新增一个 tray-app 页面，统一展示：

- 当前员工的**所有通话记录**（按时间倒序）
- 每条通话的：基础元数据、录音音频（可播放）、转写文字、（未来的）LLM 分析结论、关联订单信息
- 提供"重抓转写"按钮做兜底

> 后续 LLM 分析（识别"这通电话讲的是哪个订单/哪个客户"）由用户另行实现，本页**只把数据展示好**，给出 UI 占位区。

## 2. 信息架构

### 2.1 导航位置

Sidebar 新增第三项：

```
📥 申领台
🗂️ 我的工作台
📞 通话记录    ← 新增
```

ViewKey 类型扩展：`'intake' | 'mine' | 'calls'`

### 2.2 页面布局（两栏）

```
┌────────────────────────────────────────────────────────────────────────┐
│  通话记录 (12)                            🔄 刷新   [搜索框 phone/orderNo] │
├──────────────────┬─────────────────────────────────────────────────────┤
│                  │ 详情面板（占位 / 选中后显示）                          │
│ 左侧列表          │                                                       │
│  ┌──────────┐    │ ┌─────────────────────────────────────────────────┐ │
│  │ 18:32    │    │ │ 📞 13800001234 · 出 · 2分08秒 · 2026-05-27 18:32 │ │
│  │ 138****  │    │ ├─────────────────────────────────────────────────┤ │
│  │ *丝雨    │    │ │ 关联订单：CODf8043878... · *丝雨 · 已申领          │ │
│  │ 已完成   │    │ │            [查看订单详情] 跳到申领台 modal         │ │
│  └──────────┘    │ ├─────────────────────────────────────────────────┤ │
│  ┌──────────┐    │ │ 🎵 录音播放器（HTML <audio>，60KB ~ 几 MB）        │ │
│  │ 17:50    │    │ │  ⏵ ━━━━━○─── 01:23 / 02:08                        │ │
│  │ 138****  │    │ ├─────────────────────────────────────────────────┤ │
│  │ 未关联   │    │ │ 📝 转写文字（[客服]/[客户] 分行 + 时间戳）          │ │
│  │ 转写中…  │    │ │   [00:00] 客服：您好，我是寰宇医道...               │ │
│  └──────────┘    │ │   [00:03] 客户：我想问一下挂号...                  │ │
│  ⋮                │ │   ...                                              │ │
│                  │ │   [🔄 重抓转写] [复制全文]                          │ │
│                  │ ├─────────────────────────────────────────────────┤ │
│                  │ │ 🤖 AI 分析（占位）                                  │ │
│                  │ │ ⏳ 等待 LLM 分析中... （此区域将由你另接 LLM）       │ │
│                  │ └─────────────────────────────────────────────────┘ │
└──────────────────┴─────────────────────────────────────────────────────┘
```

### 2.3 左侧列表卡片

每条 Call 展示：

```
┌─────────────────────────┐
│ [↑/↓ 方向]  HH:MM        │  ← 方向图标 + 通话开始时分
│ 138****1234              │  ← 脱敏号码
│ 客户：*丝雨 (订单 #18)    │  ← 命中订单时；未命中显示"未关联订单"
│ 时长 2'08"  ┃ 已转写 ✓   │  ← 时长 + 转写状态徽章
└─────────────────────────┘
```

**状态徽章颜色**：
- `pending` — 灰色 "待转写"
- `processing` — 黄色脉冲 "转写中…"
- `done` — 绿色 "已转写"
- `failed` — 红色 "转写失败"
- `requires_manual` — 橙色 "需人工"

### 2.4 详情面板分区

按顺序：

1. **元数据头**：号码、方向、时长、开始时间、当前转写状态
2. **关联订单卡**：
   - 有 orderId → 显示订单号 / 就诊人 / 状态，提供"查看订单详情"按钮（复用 OrderDetailModal）
   - 无 orderId → 显示"未关联订单"+ 提示文案"等通话转写完成后 LLM 会尝试关联"
3. **录音播放器**：原生 `<audio controls>`，src = `/api/v1/calls/:id/recording-url`（新接口，后端返回 presigned GET）
4. **转写文字区**：
   - `done` → 展示 `asrText`，按行渲染，说话人前缀用色块区分（`客服` 蓝、`客户` 橙）
   - `processing` → 骨架屏 + "转写中..."
   - `failed` → 错误提示 + "重抓转写"按钮（调 `POST /calls/:id/retranscribe`）
   - 操作按钮：复制全文 / 重抓转写
5. **AI 分析区**（占位，等用户接 LLM）：
   - 字段约定：`aiSummary` 一段话 + `inferredOrderId`（LLM 推断的订单 ID）
   - 现阶段直接显示"等待 LLM 分析"

## 3. 数据获取

### 3.1 后端需要新增 1 个接口

**`GET /api/v1/calls`** — 列出当前员工的所有通话（已有的 `POST /api/v1/calls` 只能创建，没有 list 查询）

返回结构：
```ts
{
  data: Array<{
    id: number
    phone: string
    direction: 'in' | 'out'
    durationSec: number
    startedAt: string
    asrStatus: 'pending' | 'processing' | 'done' | 'failed' | 'requires_manual'
    asrFinishedAt: string | null
    hasRecording: boolean         // recordingOssKey 是否存在
    // 关联订单（不为 null 时一起返回简要信息，省一次请求）
    order: null | { id: number; sourceOrderNo: string; customerName: string; status: string }
  }>
}
```

**`GET /api/v1/calls/:id/recording-url`** — 返回 presigned GET URL 给 `<audio>` 直拉

```ts
{ data: { url: string, expiresIn: 3600 } }
```

> 之前的 `GET /api/v1/calls/:id/transcript` 已经存在，可继续用。

### 3.2 tray-app `client.ts` 新增方法

```ts
listCalls(): Promise<Call[]>
getCallRecordingUrl(id: number): Promise<{ url: string }>
getCallTranscript(id: number): Promise<Transcript>
retranscribe(id: number): Promise<{ callId: number }>
```

## 4. 实时更新策略

### 4.1 列表层

- 进入页面 → 拉一次列表
- 用户点击 "🔄 刷新" → 重拉
- **自动刷新**：列表里**只要有一条 `processing`**，每 5s 拉一次（直到全部稳定）
- 切换页面后不刷新

### 4.2 详情面板

- 选中一条 → 拉 `/transcript`
- 如果 `asrStatus = processing` → 每 3s 轮询直到 done/failed

> WS 推送是更优雅的方案（backend 转写完成时通知 tray），但当前 tray 还没有 WS 客户端，**暂不引入**。轮询逻辑跟 `OrderDetailModal` 已有的写法一致，能复用。

## 5. CSP / 安全

- `<audio src>` 拉 MinIO presigned URL（`http://47.95.14.233:9000/recordings/...`），需要在 `index.html` CSP 的 `media-src` 中放行（之前只放了 `img-src`）
- 转写文字脱敏：手机号、身份证号在前端展示前**已经由泰康那边脱敏**了，我们不再做二次处理

## 6. AI 分析区的接口约定（给用户后续接 LLM 用）

后端建议**直接复用已有的 `AiSummary` 表**（schema.prisma 里已经存在）：

```prisma
model AiSummary {
  id        Int      @id @default(autoincrement())
  orderId   Int      @map("order_id")
  type      String   // 'call' | 'message' | 'full'
  content   String
  model     String
  createdAt DateTime @default(now())
}
```

但 `AiSummary` 现在只关联到 order，**没有关联到具体 Call**。建议加一个可选字段 `callId Int?`，让一条 AiSummary 能精准对应到具体哪个通话。

然后约定：
- LLM 处理完后写入一条 `AiSummary{ callId, orderId, type: 'call', content: '...' }`
- 列表 / 详情自动读 `AiSummary where callId=:id`

接口（用户实现 LLM 后由后端暴露）：
- `GET /api/v1/calls/:id/ai-summary` → 返回该通话最新的 LLM 分析
- `POST /api/v1/calls/:id/ai-summary` → 强制重新分析（给"重新分析"按钮用）

**我现在只做 UI 占位 + GET 接口，POST 等你的 LLM 模块就绪再做。**

## 7. 拆解 To-Do

1. **后端**：
   - `GET /api/v1/calls` 列表接口（带订单关联）
   - `GET /api/v1/calls/:id/recording-url` 录音 presigned URL 接口
   - `Call`-`AiSummary` 关联：schema 加 `callId`，`GET /api/v1/calls/:id/ai-summary`
2. **tray-app api client**：4 个新方法 + `Call` 类型扩展
3. **tray-app UI**：
   - Sidebar 加"通话记录"项
   - 新页面 `CallsView.tsx`：两栏布局，左列表、右详情
   - 左列表卡片组件 + 状态徽章
   - 详情面板的 4 个分区（订单卡 / 播放器 / 转写 / AI 占位）
4. **CSP**：放行 `media-src` 到 MinIO
5. **联调**：用现成的 `Call id=2`（之前 ASR 测试创建的）验证全流程
