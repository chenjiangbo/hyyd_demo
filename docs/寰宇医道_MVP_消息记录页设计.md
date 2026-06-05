# 消息记录页设计（微信 + 企微）

> **状态**：草案 v0.1，待 review  
> **关联**：[通话记录页设计](./寰宇医道_MVP_通话记录页设计.md)  
> **日期**：2026-05-27

## 1. 现状

已有数据模型 `Message`：
```prisma
model Message {
  id, orderId?, channel('wechat'|'wxwork'), conversationName,
  senderName?, contentText, screenshotOssKey?, capturedAt, employeeId
}
```

已有接口：
- `POST /api/v1/messages` — 上报一条消息（自动按 conversationName 模糊匹配订单）

**缺**：
- 任何列表查询接口
- 任何 UI

## 2. 设计要点

### 2.1 关键观察

微信/企微聊天的核心组织单位**不是"一条消息"而是"一段会话"**——员工跟某个客户/群一聊就是几十上百条。如果直接按消息列时间线，信息密度太低，看 10 屏才知道发生了啥。

所以：**列表按"会话"聚合，详情按时间流展示消息**——和微信本身的交互模式一致，员工不需要适应。

### 2.2 渠道处理

`wechat` 和 `wxwork` 两个 channel，UI **共用一份**，用图标和颜色区分：
- 微信：绿色 💚 标识
- 企微：蓝色 💙 标识

顶部 tab 提供 `全部 / 微信 / 企微` 过滤。**不**拆成 sidebar 两个菜单——本质上是同种数据。

## 3. UI 设计

### 3.1 Sidebar 新增

```
📥 申领台
🗂️ 我的工作台
📞 通话记录
💬 消息记录    ← 新增
```

ViewKey: `'intake' | 'mine' | 'calls' | 'messages'`

### 3.2 页面布局（仿 IM 双栏）

```
┌──────────────────────────────────────────────────────────────────────┐
│  消息记录 (12 个会话)        [全部 | 微信 | 企微]    🔄 刷新           │
├──────────────────────┬───────────────────────────────────────────────┤
│ 会话列表             │ 消息流                                        │
│ ┌──────────────────┐ │ ┌──────────────────────────────────────────┐ │
│ │ 💚 *丝雨         │ │ │ 💚 *丝雨 · 个人 · 14 条                   │ │
│ │ "明天能复诊吗？" │ │ │ 关联订单：CODf80... · 已申领 [查看订单]    │ │
│ │ 14 条 · 2h ago   │ │ ├──────────────────────────────────────────┤ │
│ │ 🏷 CODf80...     │ │ │  ╭─────────────────╮                       │ │
│ ├──────────────────┤ │ │  │ 客户  14:20    │                       │ │
│ │ 💙 张三客服群    │ │ │  │ 你好，明天能...  │                       │ │
│ │ "收到"           │ │ │  ╰─────────────────╯                       │ │
│ │ 5 条 · 1d ago    │ │ │                  ╭─────────────────╮      │ │
│ │ 🏷 未关联订单    │ │ │                  │ 我    14:22    │      │ │
│ ├──────────────────┤ │ │                  │ 可以的，10 点协 │      │ │
│ │ 💚 群:复诊提醒群 │ │ │                  ╰─────────────────╯      │ │
│ │ "@all 提醒..."   │ │ │  ╭─────────────────╮                       │ │
│ │ 23 条 · 3d ago   │ │ │  │ 客户  14:25    │                       │ │
│ └──────────────────┘ │ │  │ [📷 截图]      │  ← 点开放大           │ │
│                      │ │  ╰─────────────────╯                       │ │
│                      │ ├──────────────────────────────────────────┤ │
│                      │ │ 🤖 AI 摘要                                 │ │
│                      │ │  · 客户确认明天 10 点协和复诊              │ │
│                      │ │  · 已发送地址导航                          │ │
│                      │ │  (model: qwen-max · 12:30)                 │ │
│                      │ └──────────────────────────────────────────┘ │
└──────────────────────┴───────────────────────────────────────────────┘
```

### 3.3 会话卡片（左列表项）

每张卡片展示：
- **渠道徽章** 💚/💙 + 会话名（个人名 or 群名）
- **最后一条**预览（截断 30 字）
- **消息数 + 最近时间**（"3 分钟前 / 2 小时前 / 昨天 / 3 天前"）
- **关联订单标签**：有就显示 `🏷 CODxxx...`，无就 "未关联"
- **未读标记**（占位，先不实现"已读/未读"区分）

会话定义：`(channel, conversationName, employeeId)` 三元组**联合**为一个会话。同一员工对同一联系人在同一渠道的所有消息属于同一会话。

### 3.4 消息流（右侧）

参考 IM 气泡：
- **判断我方/对方**：`senderName == 当前员工.name` → 我方，气泡右对齐 + 蓝色背景
- 否则 → 对方，左对齐 + 灰白气泡
- 群消息（多人）：左对齐均显示 senderName + 头像（首字母）
- **截图消息**：缩略图（基于 `screenshotOssKey` 申请 presigned URL），点击打开 lightbox 全屏预览
- 时间戳：每条气泡上方小字
- 自动 scroll 到底部（最新消息）

### 3.5 AI 摘要区

复用现有 `AiSummary` 表，约定：

```sql
INSERT INTO ai_summaries (order_id, call_id, type, content, model)
VALUES (
  <关联订单 id>,   -- 必填
  NULL,            -- 消息摘要不绑特定通话
  'message',
  '<摘要文本>',
  '<model>'
);
```

显示位置：消息流底部（**不放顶部**——避免抢占滚动焦点；员工要时直接拉到底就行）

> LLM 处理逻辑由用户实现，本页只展示。

## 4. 数据接口

后端要新增 3 个：

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/v1/conversations` | 当前员工的会话列表。按 `(channel, conversationName)` group by，返回最近一条 + 消息数 + 关联订单（如有） |
| GET | `/api/v1/conversations/:channel/:name/messages` | 该会话所有消息，时间正序 |
| GET | `/api/v1/messages/:id/screenshot-url` | 单条消息截图的 presigned URL |
| GET | `/api/v1/orders/:id/messages/ai-summary` | 该订单的最新一条 `type='message'` AI 摘要（可选） |

### 4.1 会话列表返回格式

```ts
{
  data: Array<{
    channel: 'wechat' | 'wxwork'
    conversationName: string
    messageCount: number
    lastMessageAt: string        // ISO
    lastMessagePreview: string   // 截 30 字
    order: null | {
      id, sourceOrderNo, customerName, status
    }
  }>
}
```

> 用 SQL `GROUP BY channel, conversation_name` 一次查完，比循环每个会话再查最后一条快得多。

### 4.2 会话消息流返回

```ts
{
  data: Array<{
    id: number
    senderName: string | null
    contentText: string
    capturedAt: string
    isMine: boolean              // 后端判断 senderName == 当前员工.name
    hasScreenshot: boolean       // screenshotOssKey 存在
    orderId: number | null       // 该条消息关联的订单
  }>,
  order: null | { /* 该会话关联的订单（取最近一条 message.orderId） */ }
}
```

## 5. 实时更新

- 进入页面 → 拉一次会话列表
- 用户点击 🔄 → 重拉
- **自动刷新**：每 10s 后台拉一次会话列表（消息上报相对低频，不像 ASR 那样要 3s 轮询）
- 选中的会话被打开时，再用一个 30s 间隔的轮询拉该会话消息（新消息会追加到底）

> 与 calls 页一样，**不引入 WS** 给 tray，保持当前 polling 风格。

## 6. CSP

- `img-src` 已经放行 MinIO（订单附件用过），截图直接复用
- 不需要其他改动

## 7. 隐私 / 工作合规

- 消息内容**已经在采集端**做过敏感词/电话脱敏处理（假设——用户的微信采集插件负责）
- 截图 presigned URL 1h TTL，**不放到任何前端缓存**

## 8. 拆解 To-Do

1. **后端**：3 个新接口（list / messages / screenshot-url）+ 1 个可选 ai-summary
2. **tray-app api client**：扩 `Conversation / ChatMessage` 类型 + 4 个方法
3. **tray-app UI**：
   - Sidebar 加 "💬 消息记录"
   - 新页面 `MessagesView.tsx`：双栏 + tab + 气泡 + AI 摘要
   - 截图 lightbox（可复用 `OrderDetailModal` 里的 `<img>` 预览块或抽出公共组件）
4. **联调**：用现成的或临时插入的几条 message 验证

## 9. 后续可能的扩展（先不做）

- 全局搜索（按内容关键字跨会话搜消息）
- 时间范围过滤
- 导出会话为 PDF / Markdown
- 多 message 类型（语音 / 链接 / 红包 等）—— 目前只支持 text + screenshot
