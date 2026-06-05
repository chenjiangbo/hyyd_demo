# 寰宇医道 MVP - 企微 / 微信消息采集总体设计

> **状态**：草案 v0.3，按自研窗口采集方案更新  
> **日期**：2026-05-28  
> **关联**：[企微和微信消息采集的思路](./企微和微信消息采集的思路.md) / [消息记录页设计](./寰宇医道_MVP_消息记录页设计.md)

## 1. 背景

寰宇医道员工在履约过程中大量使用企业微信和个人微信与客户沟通。当前沟通证据散落在员工自己的微信 / 企微里，月底补录、客诉举证、结算核对和 AI 服务复盘都缺少稳定的数据来源。

MVP 要验证的是：

```text
不 hook 微信 / 企微
不解密微信本地数据库
不调用微信私有协议
只通过员工可见桌面中的目标窗口截图 + OCR
把打开过的客户沟通整理成可回溯的消息证据链
```

早期验证过 screenpipe，但 screenpipe 在本项目里不再作为最终采集组件。原因是它实际保存的是全屏截图和全屏 OCR，容易混入 PowerShell、系统弹窗、任务栏等内容，隐私边界也不够清楚。

最终方案改为：

```text
Tray App 自己管理采集
Windows 原生 sidecar 只截 WXWork.exe / WeChat.exe 目标窗口
Windows OCR 识别整张目标窗口并返回 text + bbox
VLM 低频识别窗口内 sidebar/title/chat/input 区域
本地代码按坐标分区、提取消息块、去重、保存 SQLite
```

## 2. 目标 / 非目标

### 2.1 目标

1. 只在前台窗口为 `WXWork.exe` / `WeChat.exe` 时采集。
2. 只保存目标窗口截图，不保存全屏截图。
3. 保存原始窗口截图、OCR 文本、OCR bbox、窗口状态和 layout 版本，保证后续算法可重跑。
4. 先在本地 SQLite 还原“打开过的会话”和“疑似消息块”。
5. 按会话分桶后再去重，避免把不同客户都说的“好的”误删。
6. 每条消息块都能回溯到来源截图。
7. 后续再把人工 / LLM 确认后的消息写入正式 `messages`。

### 2.2 非目标

- 不 hook 微信 / 企微进程。
- 不读取或解密微信本地数据库。
- 不调用微信私有协议。
- 不使用 screenpipe 作为采集组件。
- 不自动给客户发消息。
- 不在 MVP 第一阶段直接写正式 `messages`。
- 不保证第一阶段 100% 还原双方逐句聊天。

## 3. 客户备注规范

为了让系统稳定，工作客户需要统一备注真实姓名 + 手机号。

推荐格式：

```text
张三 13800138000
张三-13800138000
泰康张三 13800138000
```

原因：

1. 手机号可以直接匹配订单，比微信昵称可靠。
2. 微信昵称大部分不是真名，不能作为稳定主键。
3. 私人聊天即使被采为原始证据，也不会自动进入正式客户消息链。
4. 群聊和客户私聊可以分开处理。

MVP 规则：

- title 或会话名里能提取手机号：优先按手机号识别客户。
- 不能提取手机号：进入 `unknown_private` / `unknown_group`，不自动关联订单。
- 群聊默认不自动绑定单个订单，除非群名或消息内容明确出现手机号 / 订单号。

## 4. 总体架构

```text
员工 Windows 桌面
  └─ Tray App (Electron)
      ├─ 启动 hyyd-capture-sidecar.exe
      ├─ 通过 JSON Lines IPC 发送 start/stop/ping
      ├─ 接收 frame/status/error
      ├─ 写本地 SQLite
      ├─ 展示采集状态和本地还原结果
      └─ 后续上传原始证据 / 候选消息到后端

hyyd-capture-sidecar.exe
  ├─ GetForegroundWindow
  ├─ 识别进程名 WXWork.exe / WeChat.exe
  ├─ 截取目标窗口截图
  ├─ Windows.Media.Ocr
  └─ 返回窗口状态 + screenshot_path + OCR blocks

后端
  ├─ 原始证据归档
  ├─ 会话桶
  ├─ message_candidates
  ├─ messages
  ├─ 订单匹配
  └─ LLM 消息链整理
```

员工视角只有 Tray App 一个应用。sidecar 是 Tray App 后台启动的子进程，不需要员工手动打开。

## 5. Sidecar 职责

sidecar 负责 Windows 原生能力：

1. 监听 / 查询当前前台窗口。
2. 判断进程名是否为 `WXWork.exe` / `WeChat.exe`。
3. 窗口最小化、不可见、尺寸异常时不采集并返回状态。
4. 截取目标窗口截图，坐标相对于窗口本身。
5. 调用 Windows OCR，返回 line / word 文本和 bbox。
6. 把采集结果通过 stdout JSON Lines 发给 Tray App。

sidecar 不负责：

- 本地 SQLite。
- 订单匹配。
- VLM 分区。
- 消息去重。
- 上传后端。
- 生成正式 `messages`。

核心步骤失败时必须返回 `error`，不能改为全屏截图、screenpipe 或其他隐式兜底。

## 6. Tray App 与 Sidecar 通信

MVP 使用 JSON Lines over stdin/stdout。

Tray App 发送：

```json
{"type":"start","requestId":"..."}
{"type":"stop","requestId":"..."}
{"type":"ping","requestId":"..."}
```

sidecar 返回：

```json
{"type":"ready","protocolVersion":1}
{"type":"status","collecting":true}
{"type":"error","message":"..."}
```

采集帧：

```json
{
  "type": "frame",
  "channel": "wxwork",
  "processName": "WXWork.exe",
  "windowTitle": "张三 13800138000",
  "capturedAt": "2026-05-28T10:00:00.000Z",
  "window": {
    "left": 120,
    "top": 80,
    "width": 1280,
    "height": 820,
    "showState": "normal"
  },
  "screenshotPath": "C:/Users/.../capture/frames/xxx.png",
  "imageHash": "...",
  "ocr": {
    "engine": "windows_ocr",
    "status": "success",
    "text": "好的，明天上午十点到",
    "blocks": [
      {
        "text": "好的，明天上午十点到",
        "bbox": { "x": 625, "y": 220, "width": 210, "height": 24 },
        "confidence": 0.92
      }
    ]
  }
}
```

## 7. 截图与 OCR 频率

MVP 采集规则：

```text
目标窗口在前台：
  每 3 秒截一帧并 OCR

目标窗口不在前台：
  不截、不 OCR

刚切换到目标窗口：
  延迟 500-800ms 截第一帧

窗口最小化：
  不截、不 OCR

窗口大小 / 最大化状态变化：
  等 500-800ms 稳定后截一帧
  触发 VLM 重新分区
```

只移动窗口位置不触发 VLM，因为截图和 OCR 坐标都相对于目标窗口图本身。

## 8. VLM 分区

Windows OCR 识别整张目标窗口，不先裁 chat 区。

VLM 只做低频分区：

```json
{
  "imageWidth": 1280,
  "imageHeight": 820,
  "regions": {
    "sidebar": { "x1": 0, "y1": 0, "x2": 310, "y2": 820 },
    "title": { "x1": 310, "y1": 0, "x2": 1280, "y2": 70 },
    "chat": { "x1": 310, "y1": 70, "x2": 1280, "y2": 650 },
    "input": { "x1": 310, "y1": 650, "x2": 1280, "y2": 820 }
  },
  "confidence": 0.86
}
```

触发条件：

1. 当前 app 没有可用 layout。
2. app 从微信切到企微，或从企微切到微信。
3. 窗口宽高变化。
4. 最大化 / 恢复状态变化。
5. 每 5 或 10 分钟定时校准一次。

VLM 输出必须校验字段齐全、坐标不越界、区域顺序合理。输出不合法时，不更新 layout。

## 9. 本地 SQLite

Tray App 使用自己的本地 SQLite，不使用 screenpipe SQLite。

路径：

```text
%APPDATA%/<tray-app>/capture/capture.db
```

核心表：

```text
capture_frames
  原始窗口截图、窗口状态、OCR text、OCR blocks、hash、layout_version_id

layout_versions
  VLM 返回的 sidebar/title/chat/input 区域坐标

conversation_threads
  每个员工打开过的会话桶

message_blocks
  OCR 提取后的疑似消息块，尚不是正式 messages
```

第一阶段只要求 `capture_frames` 能稳定落库。`conversation_threads` 和 `message_blocks` 随后在本地算法层填充。

## 10. 去重策略

去重顺序必须是：

```text
先识别当前会话
再在会话内按时间排序
再做帧级和消息块级去重
```

不能在全天所有截图里全局去重，因为不同客户可能都会回复“好的”“收到”。

帧级去重：

```text
图片相似
+ chat 区 OCR 文本相同
=> 不进入消息提取，只更新 last_seen_at
```

消息块去重：

```text
thread_id + sender_type + normalized_content_hash
```

短文本要特殊处理：

```text
短文本相同且 2 分钟内重复出现：
  认为重复

短文本相同但间隔超过 2 分钟：
  可以新增
```

## 11. MVP 阶段

### 阶段 1：采集链路

1. Tray App 能启动 sidecar。
2. sidecar 能返回状态和错误。
3. Windows VM 中能只采集 `WXWork.exe` / `WeChat.exe` 前台窗口。
4. 保存目标窗口截图，不保存全屏。
5. Windows OCR 能输出中文 text + bbox。
6. `capture_frames` 能落库。

### 阶段 2：分区和会话

1. VLM 返回 sidebar/title/chat/input。
2. OCR blocks 能按区域分区。
3. title 区能识别当前会话。
4. 能创建 / 更新 `conversation_threads`。

### 阶段 3：消息块

1. chat 区 OCR line 合并为 message_blocks。
2. 能判断 self / other / system / unknown。
3. 会话内去重能减少重复截图带来的重复消息。
4. 每条 message_block 能回溯来源截图。

### 阶段 4：后端和人工确认

1. 上传原始证据和候选消息。
2. 人工 / LLM 确认候选消息。
3. 只把确认后的结果写入正式 `messages`。

## 12. 验收标准

1. 只在 `WXWork.exe` / `WeChat.exe` 前台时采集。
2. 关闭微信 / 企微或切到其他应用时停止采集。
3. 不保存全屏截图。
4. 不产生 screenpipe 数据目录、视频或 SQLite。
5. OCR 结果包含 bbox。
6. 采集失败时状态栏显示明确错误，不生成消息。
7. 同一屏长时间停留不会产生大量重复消息。
8. 切换会话后，消息进入对应 conversation_thread。
9. 每条 message_block 能回溯到来源截图。

## 13. 当前实现状态

已完成实现：

1. Tray App 主进程新增 sidecar client。
2. Tray App 通过 JSON Lines 启动 / 管理 sidecar。
3. 本地 SQLite schema 已建立。
4. 状态栏已从 screenpipe 状态切换为微信 / 企微采集状态。
5. screenpipe collector、probe 脚本和 deploy probe 模式已移除。
6. sidecar 已实现 `GetForegroundWindow` + 进程名识别，只处理 `WXWork.exe` / `WeChat.exe`。
7. sidecar 已实现目标窗口矩形截图、PNG 保存和 SHA256。
8. sidecar 已实现 Windows OCR 调用，输出 text + word bbox。
9. Tray App 已实现帧级重复标记：重复帧仍进 `capture_frames`，状态为 `skipped_duplicate`。
10. Tray App 已实现基础 `conversation_threads` 和 `message_blocks` 生成。
11. Tray App 已实现 OpenAI-compatible VLM layout 接口，并强制要求 `HYYD_VLM_BASE_URL`、`HYYD_VLM_API_KEY`、`HYYD_VLM_MODEL`。
12. VLM layout 可用时，Tray App 会用 title/chat 区域坐标从 OCR blocks 中切出会话标题和聊天文本；未启用 VLM 时只保存整窗 OCR 粗候选。
13. Windows deploy 流程已加入 `pnpm sidecar:build:win`，会按 Windows 架构选择 `win-arm64` / `win-x64`，sidecar 构建失败会中断部署。

待 Windows VM 实测确认：

1. Windows OCR SDK 包在 VM 上能否直接 restore / publish。
2. 微信 / 企微窗口矩形截图是否稳定、是否受遮挡影响。
3. OCR bbox 在不同 DPI / 缩放比例下是否与截图像素坐标一致。
4. VLM layout JSON 是否符合校验规则。
