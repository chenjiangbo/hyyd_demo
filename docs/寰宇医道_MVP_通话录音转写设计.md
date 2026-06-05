# 通话录音转写设计（接入通义听悟）

> **状态**：草案 v0.1，待 review 确认  
> **日期**：2026-05-27

## 1. 背景与现状

数据库已有 `Call` 模型（含 `recordingOssKey / asrText / asrStatus`），以及 `POST /api/v1/recordings` 接口：

```
客户端 ─ POST /api/v1/recordings(callId, ossKey, durationSec) ─→ 后端
       ←─ uploadUrl (MinIO presigned PUT)
       ─ PUT uploadUrl (binary) ─→ MinIO  ✅ 录音直传完成
                                  ❌ 之后 asrStatus 一直停在 'pending'，没人转写
```

要做的事：录音上传完成 → 自动触发通义听悟离线转写 → 把结果回写到 `Call.asrText` 并更新 `asrStatus`。

## 2. 通义听悟离线转写要点（来自[官方文档](https://help.aliyun.com/zh/tingwu/offline-transcribe-of-audio-and-video-files)）

- **端点**：`https://tingwu.cn-beijing.aliyuncs.com/openapi/tingwu/v2/tasks?type=offline`，方法 `PUT`
- **鉴权**：阿里云 AccessKey（AccessKeyId + AccessKeySecret），region `cn-beijing`，业务方还要在听悟控制台拿一个 `AppKey`
- **请求体**（最小）：
  ```json
  {
    "AppKey": "<your_appkey>",
    "Input": {
      "SourceLanguage": "cn",
      "FileUrl": "<音频 http(s) URL>"
    }
  }
  ```
- **可选配置**（写在 `Parameters` 节）：
  - `Transcription.DiarizationEnabled = true` + `SpeakerCount = 2` → 启用**话者分离**（客服 ↔ 客户）
  - `Summarization` / `AutoChapters` → 摘要、章节（先不开，省钱）
- **响应**：返回 `Data.TaskId` 和 `TaskStatus: ONGOING`
- **查询**：`GET /openapi/tingwu/v2/tasks/{TaskId}`，状态 `ONGOING / COMPLETED / FAILED`
- **结果**：完成后 `Data.Result.Transcription` 是一个 URL（30 天 TTL），下载 JSON 拿带说话人/时间戳的转写文本
- **回调**：支持 `ProgressiveCallbacksEnabled`，**但需要公网入口** —— MVP 阶段我们没有，所以走**轮询**

## 3. 设计

### 3.1 触发时机

`POST /api/v1/recordings` 处理函数末尾、已经把 `recordingOssKey` 写入后，**异步**触发转写（不阻塞返回）：

```ts
return reply.send({ data: { call, uploadUrl } })
void scheduleTranscription(call.id)  // 后台跑，不 await
```

为什么不在客户端 PUT 完再触发：客户端 PUT 是直传 MinIO，后端不知道完成时刻。要么客户端再调一次"上传完成"通知，要么后端**异步轮询 MinIO 看对象是否就绪**。MVP 选后者：

```ts
async function scheduleTranscription(callId) {
  // 1. 等 MinIO 对象就绪（最多 60s）
  // 2. 生成对外可达的音频 URL（presigned GET，有效期 24h，给阿里云访问）
  // 3. 调 CreateTask → 拿 taskId，写入 Call.tingwuTaskId
  // 4. 启动轮询：每 30s GetTaskInfo，直到 COMPLETED / FAILED / 超时(30min)
  // 5. 下载 Result.Transcription JSON，提取带说话人的文本，写入 asrText
}
```

### 3.2 阿里云访问 MinIO 的 URL 怎么办

阿里云听悟的服务端要拉音频文件，它**在公网上**——但我们 MinIO 在 Mac 本地（`192.168.202.1:19000`），阿里云访问不到。

**两种方案**：

**A. 把音频转传到 OSS（推荐）**  
后端从 MinIO 读出录音 → 上传到阿里云 OSS → 用 OSS URL 调听悟。完成后可选删 OSS 对象。

- 优点：阿里云内部走 OSS 拉文件最快、最稳；不依赖本机公网
- 缺点：增加 OSS bucket 配置、流量费（很小，单次几 MB）

**B. 给本机搭隧道（cloudflared / ngrok）**  
跑一个 cloudflared 隧道把 MinIO 端口暴露成公网 URL，听悟通过那个 URL 拉。

- 优点：不用配 OSS
- 缺点：依赖第三方隧道，开发环境不稳定，正式部署还得换

**我推荐 A**——和最终生产架构一致（生产环境后端肯定在云上、对接 OSS）。

### 3.3 数据模型

`Call` 表新增字段（用来追踪 tingwu 任务）：

```prisma
model Call {
  // ... 现有字段
  tingwuTaskId    String?  @map("tingwu_task_id")
  asrFinishedAt   DateTime? @map("asr_finished_at")
  asrResultJson   Json?    @map("asr_result_json")   // 完整转写 JSON，方便后续摘要/搜索
}
```

`asrStatus` 状态机扩展：
- `pending` → 等待录音上传完成
- `processing` → 听悟在跑
- `done` → 完成
- `failed` → 失败
- `requires_manual` → 需要人工兜底（超时/异常）

### 3.4 转写结果存储

听悟的 Transcription JSON 结构（简化）：
```json
{
  "Paragraphs": [
    { "SpeakerId": "1", "Text": "您好，我是寰宇医道...", "StartTime": 0, "EndTime": 3200 },
    { "SpeakerId": "2", "Text": "我想问一下挂号...", "StartTime": 3500, "EndTime": 6000 }
  ]
}
```

我们存两份：
- `asrText` (TEXT) — 渲染好的纯文本（`[客服] 您好... \n[客户] 我想...`），给 UI 直接展示
- `asrResultJson` (JSONB) — 完整结构，给将来摘要/检索/前端高亮用

### 3.5 配置项

`.env` 新增：
```bash
ALIYUN_AK_ID="xxx"                # 阿里云主账号或 RAM 用户 AccessKey
ALIYUN_AK_SECRET="xxx"
TINGWU_APPKEY="xxx"               # 听悟控制台创建的 AppKey
TINGWU_REGION="cn-beijing"        # 听悟默认就这一个 region
ALIYUN_OSS_BUCKET="huanyu-recordings"     # 用于中转录音的 OSS bucket
ALIYUN_OSS_REGION="cn-beijing"
ALIYUN_OSS_ENDPOINT="oss-cn-beijing.aliyuncs.com"
```

> **请你晚点把 4 个 `xxx` 填到 `packages/backend/.env`**：
> - `ALIYUN_AK_ID`、`ALIYUN_AK_SECRET`、`TINGWU_APPKEY`、`ALIYUN_OSS_BUCKET`（OSS bucket 要你先去 OSS 控制台建一个）

### 3.6 SDK 选型

听悟没官方 Node.js SDK。两种实现路径：

1. **直接 HTTP** + `@alicloud/openapi-client`（阿里云的鉴权工具库）—— 轻、可控
2. **`@alicloud/tingwu20230930`** —— 阿里云 OpenAPI 自动生成的 TS SDK，封装了鉴权

OSS 用 `ali-oss` 官方包。

我倾向**方案 2** + `ali-oss`，少写鉴权代码。

## 4. 工作流图

```
[客户端]
   │ POST /recordings
   ▼
[后端] ────► MinIO uploadUrl
   │ (异步起 transcription job)
   ▼
等 MinIO 对象就绪 (轮询，最多 60s)
   │
   ▼
从 MinIO 读 → 传到 阿里云 OSS → 拿 OSS URL
   │
   ▼
PUT /openapi/tingwu/v2/tasks?type=offline ─► 通义听悟
   │ 拿到 TaskId，写入 Call.tingwuTaskId
   │ Call.asrStatus = 'processing'
   ▼
轮询 GET /tasks/{TaskId}  每 30s, 最多 30 min
   │
   ▼
COMPLETED → 下载 Result.Transcription JSON → 渲染 + 入库
   │ Call.asrText / asrResultJson / asrFinishedAt
   │ Call.asrStatus = 'done'
   ▼
（可选）删除 OSS 对象
```

## 5. 失败兜底

- **MinIO 对象 60s 还没就绪** → `asrStatus = 'failed'`，记日志，需用户手动重试
- **OSS 上传失败** → 同上
- **CreateTask HTTP 失败 / 鉴权错** → 同上
- **轮询 30 分钟还没完成** → `asrStatus = 'requires_manual'`，保留 TaskId 用户可以手动去听悟控制台查
- **进程重启了，正在跑的任务"丢"了** → 启动时扫一遍 `Call` 表里 `asrStatus='processing' AND tingwuTaskId IS NOT NULL` 的恢复轮询

## 6. 新增接口（可选）

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/v1/calls/:id/retranscribe` | 手动重新转写（asrStatus 不论什么状态都允许） |
| GET | `/api/v1/calls/:id/transcript` | 返回 `asrText / asrResultJson` 给前端展示 |

## 7. 测试 / 验收

1. 用 curl 上传一个真实 .wav 文件到 `/recordings`
2. 看后端日志：
   - "录音 MinIO 已就绪"
   - "上传至 OSS: ..."
   - "听悟 CreateTask 返回 taskId=xxx"
   - "听悟 任务 xxx 状态: ONGOING"... "COMPLETED"
   - "转写完成: 渲染文本 xxx 字符"
3. 数据库 `calls` 表对应行 `asrStatus=done`, `asrText` 有内容, `asr_result_json` 有完整 JSON
4. 失败场景：故意上传一个 0 字节文件 → asrStatus 应该 = `failed` 而不是卡住

## 8. To-Do 拆解

1. **DB schema**：`Call` 加 `tingwuTaskId / asrResultJson / asrFinishedAt`
2. **依赖 + 配置**：安装 SDK，扩 `.env`
3. **转写服务模块** `tingwuClient.ts`：CreateTask / GetTaskInfo / 下载结果 三个原子操作 + 错误分类
4. **OSS 中转模块** `recordingsBridge.ts`：MinIO→OSS / 等就绪 / 清理
5. **调度器** `transcribeScheduler.ts`：触发 + 轮询，提供 `scheduleTranscription(callId)`
6. **REST 接口**：`/calls/:id/retranscribe` + `/calls/:id/transcript`
7. **重启恢复**：启动时扫 `processing` 状态恢复轮询
8. **端到端测试**
