# AI 调用与提示词审计

更新时间：2026-10-28
审计范围：`packages/backend/src`、`packages/tray-app/src`、`packages/admin-web/src`、`packages/extension/src`、`packages/capture-sidecar`

## 1. 结论先行

当前项目中实际存在 6 类模型能力：

| 能力 | 模型接口 | 当前主要用途 | 是否有提示词 |
| --- | --- | --- | --- |
| 电话录音转写 | 阿里云百炼 Fun-ASR | 音频转文字、返回说话人编号 | 没有文本提示词，只有 ASR 参数 |
| 图片理解 | 百炼 OpenAI 兼容视觉接口 | 手工补录图片的分类与 OCR | 有 |
| 身份证 OCR | 百炼视觉接口 | 挂号协助订单身份证人像面识别 | 有 |
| 订单 AI 简报 | 百炼文本接口 | 生成阶段、摘要、风险、待办、关键信息和工作流事件 | 有 |
| 订单字段候选提取 | 百炼文本接口 | 按订单服务类型提取可回填字段候选 | 有，当前是核心新链路 |
| 旧版摘要/关键信息抽取 | 百炼文本接口 | 通话摘要、微信摘要、全单摘要、旧版关键信息抽取 | 有，主要通过后端接口手工触发 |

当前 Tray App、插件和 sidecar 不直接持有模型密钥。主要模型调用都发生在后端。

最需要优先检查的不是单句提示词，而是下面几件事：

1. **订单字段分析的业务上下文仍然不完整。** 当前会把同一申请号下的全部消息和通话交给每一张订单分析，但只给模型当前这一张订单的服务类型和少量正式字段，没有明确列出同申请号下的其他订单及其边界。提示词虽写了“不能把另一服务订单的信息写入本订单”，但仅靠文字约束不足以稳定解决多订单归属问题。
2. **同一项目同时保留两套分析体系。** `refreshOrderBrief` 会先跑“订单简报”，再跑“订单字段候选提取”；旧版 `extractKeyInfo`、`summarizeCall`、`summarizeMessages`、`summarizeFull` 也仍然存在。它们的字段定义、订单粒度、时间规则和输出约束不完全一致，容易造成页面或后续流程使用不同口径。
3. **新采集时间、方向和类型需作为明确证据传入。** 新原生采集消息以 `occurredAt` 作为消息发生时间；`observedAt` 是系统采集时间，只用于后台静默和更新判断，不发送给模型。订单字段提取器还会显式传入方向、标准化类型和来源类型码。旧截图 `Message` 记录仍使用 `sortTime ?? chatTime ?? capturedAt`。
4. **部分旧链路存在明确截断。** 旧版全单摘要对每通电话截取 800 个字符、全部消息拼接后截取 1000 个字符、订单详情截取 500 个字符；这不适合作为完整业务事实提取链路。
5. **图片/身份证识别失败存在静默继续。** 图片理解失败后简报仍继续，身份证 OCR 只取前 4 个附件；这会造成“AI 没看到证据”与“证据不存在”难以区分。
6. **触发策略已改为按素材类型处理。** 电话 ASR 保存成功后立即触发；微信/企微按申领号静默 5 分钟后逐单分析；手工补录素材静默 3 分钟后分析。管理后台现展示该策略，不再提供定时时点配置。

## 2. 调用总表

### 2.1 当前调用入口

| 编号 | 调用函数 | 文件 | 触发方式 | 输入范围 | 输出去向 |
| --- | --- | --- | --- | --- | --- |
| A1 | `createTranscription` / `getTask` | `packages/backend/src/asr/funAsrClient.ts` | 录音上传确认后，ASR 调度器提交并轮询 | 单个录音文件 URL | `calls.asrText`、`asrResultJson`、`asrStatus` |
| A2 | `understandImage` | `packages/backend/src/llm/imageUnderstandService.ts` | 订单 AI 分析前，订单存在未识别图片素材时 | 单张手工补录图片 | `materials.aiImageKind`、`aiImageText` |
| A3 | `buildOrderBrief` | `packages/backend/src/llm/orderBriefService.ts` | 订单简报手动刷新、旧申请级简报手动刷新；自动简报调度器仍存在但当前启动处未见启用 | 订单或申请号下的消息、通话、素材 | `orders.aiBriefJson` 或 `application_briefs.brief_json` |
| A4 | `extractOrderServiceFields` | `packages/backend/src/llm/orderAiExtraction.ts` | ASR 转写完成后立即触发；微信/企微按申领号静默 5 分钟触发；手工“重新分析字段” | 当前订单服务类型对应字段 + 同申请号消息/通话/素材 | `b_order_ai_analysis_runs`、`b_order_ai_field_candidates`、部分工作流事件 |
| A5 | `visionChat` 身份证提示词 | `packages/backend/src/services/orderIdCardOcr.ts` | 泰康挂号协助订单详情回拉/同步后，后台异步尝试一次 | 身份证附件，当前最多前 4 张 | 远端寰宇主表身份证号 |
| A6 | `summarizeCallCommunication` | `packages/backend/src/llm/summaryService.ts` | 通话摘要接口；写 B 端沟通记录时若无已有内容且电话已转写 | 单通话 ASR 文本 | `ai_summaries` 或 B 端沟通记录 |
| A7 | `summarizeMessages` | `packages/backend/src/llm/summaryService.ts` | 后端旧接口手动调用 | 指定 `orderId` 下消息 | `ai_summaries` |
| A8 | `summarizeFull` | `packages/backend/src/llm/summaryService.ts` | 后端旧接口手动调用 | 指定订单的通话、消息、订单详情 | `ai_summaries` |
| A9 | `extractKeyInfo` | `packages/backend/src/llm/keyInfoService.ts` | `POST /api/v1/ai/extract-key-info` 手动调用 | 调用方直接提交的带说话人对话 | 直接返回，不自动入库 |

### 2.2 未发现当前业务调用的客户端 AI

以下能力在代码中保留了客户端或旧网关实现，但当前没有发现业务调用方：

- `chatStream`、`submitJob`、`getJobResult`：仍在 `gatewayClient.ts`，依赖 `GATEWAY_*`，当前没有找到调用点。
- `packages/tray-app/src/main/capture-ai-reconstruct.ts`：明确抛出“AI 还原已迁移到后端”，当前不应被当作实际 AI 链路。
- `packages/tray-app/src/main/capture-layout-service.ts`：VLM 布局识别服务已标记弃用，sidecar 当前使用确定性 OCR/列检测。
- `packages/capture-sidecar`：没有发现直接调用 LLM/VLM 的代码。

## 3. 触发逻辑详解

### 3.1 电话转写：不经过文本提示词

文件：

- `packages/backend/src/asr/transcribeScheduler.ts`
- `packages/backend/src/asr/funAsrClient.ts`

主要流程：

1. Android 上传录音并确认 MinIO 对象存在。
2. `scheduleTranscription(callId)` 调用 Fun-ASR 异步接口。
3. 每 30 秒轮询任务，最长 30 分钟。
4. 成功后下载 `transcription_url`，调用 `renderTranscriptText` 写入 `calls.asrText`。

提交参数只有：

```json
{
  "model": "fun-asr",
  "input": { "file_urls": ["录音文件 URL"] },
  "parameters": {
    "diarization_enabled": true,
    "speaker_count": 2
  }
}
```

当前只保留 `speaker_id`，不会在转写阶段判断谁是客户、谁是员工。这一判断被留给后续摘要/字段提取模型，且后续文本中只有“去电/来电”和“说话人 0/1”信息，身份上下文不足。

### 3.2 新订单 AI 字段分析

入口：

- 后台调度：`packages/backend/src/jobs/orderAiSchedule.ts`
- 手工重跑：`POST /api/v1/orders/:id/ai-fields/reanalyze`
- 实际编排：`packages/backend/src/jobs/orderBriefRunner.ts` 的 `analyzeOrderFields`

自动触发条件（2026-10-28 更新）：

- 电话录音：ASR 转写文本成功保存后，立即触发对应订单及同申领号关联订单分析；后台另每 30 秒扫描未推进水位的已完成转写，确保服务重启或瞬时失败后仍能发现待处理通话。
- 微信/企微：以申领号为沟通合并范围，最后一条新消息或附件更新后静默 5 分钟，再按订单分别分析。后台每 30 秒检查一次，因此通常在静默满 5 分钟后的下一次检查启动。
- 手工补录素材仍按最后一条新增素材静默 3 分钟触发。
- 同一订单分析正在运行时若又有触发到达，会在当前分析结束后补跑，读取最新素材；不会并行重复处理同一订单。
- 手工重跑使用 `force=true`，跳过新内容判断。

输入范围：

- 当前订单的 `orderId`、`applicationNo`、`serviceType`。
- 当前正式值：医院、科室、医生、服务备注、B 端已保存字段。
- 同一申请号下所有消息和通话，以及当前订单的手工补录素材。
- 原生微信/企微消息使用采集器提供的准确 `occurredAt`；旧截图消息仍使用 `sortTime ?? chatTime ?? capturedAt`。系统采集时间 `observedAt` 不进入 AI 时间线。
- 原生消息同时传入方向、标准化类型、来源类型码和合并消息序号；`unknown` 方向明确标为未知，不推断为客户或专员。
- 通话时间使用 `startedAt`。
- 最终在 `timeline()` 中再次按时间升序排列。

实际 system prompt 由三部分组成：

1. `ORDER_AI_PROMPT_RULES`：业务规则、时间规则、陪诊规则、取消规则、医院/科室/医生规范、状态和工作流事件规则。
2. JSON 输出示例：`field_candidates` 和 `workflow_events`。
3. 输出只能使用当前服务类型允许的字段白名单。

实际 user prompt 结构：

```text
【当前订单】订单ID=...；申请号=...；服务类型=...

【本单允许提取字段】field_code（field_label）；...

【当前已保存正式值，仅用于判断变更，不得照搬】{...}

【申请号下沟通时间线】
[消息#123 2026-... wechat/发送人] ...
[通话#456 2026-... 去电] ...
```

输出要求：

- `field_candidates`：字段编码、候选值、标准化值、候选类型、置信度、是否需要确认、证据来源 ID。
- `candidate_type`：`new_or_confirmed`、`change_candidate`、`ambiguous`。
- `workflow_events`：只能输出明确完成或确认的事件。
- 结果先写候选表，不直接覆盖正式字段。
- 只有字段提取器返回的工作流事件才会尝试推进流程。

### 3.3 订单 AI 简报

文件：`packages/backend/src/llm/orderBriefService.ts`

手动入口：

- `POST /api/v1/orders/:id/brief/refresh`
- `POST /api/v1/applications/:applicationNo/brief/refresh`

订单级输入：

- 当前订单的客户姓名、服务类型、项目名、医院、科室、医生、状态。
- 该申请号下所有微信/企微消息和通话；无申请号时使用订单自身数据。
- 当前订单的所有手工补录素材。
- 图片素材在进入简报前先经过一次图片理解并缓存文字。

订单级调用的当前实现是全量重算：`refreshOrderBrief` 传给 `buildOrderBrief` 的 `prevBrief` 为 `null`，即使提示词中有“增量更新、保留上一版信息”的规则，也不会把上一版简报传给模型。上一版只用于触发判断和数据库状态。

申请级输入：

- 同一申请号的全部消息和通话。
- 同申请号下所有订单汇总出的服务类型、医院、科室等上下文。
- 申请级简报不会调用字段候选提取器。

简报 system prompt 的业务背景包括：

- 这是医疗绿通服务，可能涉及挂号、门诊、检查加急、住院、护工、接送、会诊等。
- 消息来源为微信、企微、电话录音转写和专员手工补录。
- OCR 和 ASR 可能有错别字，要求按语义理解。
- 电话只提供去电/来电方向，不能可靠区分说话人。
- 企微派发的陪诊人优先于微信旧派单信息。
- 输出摘要、阶段、客户问题、下一步、风险、关键信息和已确认工作流事件。

输出结构：

```json
{
  "summary": "2-4句自然语言简报",
  "stage": "待跟进 | 沟通中 | 办理中 | 已安排已通知 | 服务执行中 | 已完成",
  "stageEvidence": "阶段依据",
  "hasOpenIssue": true,
  "nextActions": ["下一步待办"],
  "risks": ["风险或信息缺口"],
  "keyInfo": {
    "目标医院": "值或null",
    "科室或病种": "值或null",
    "意向专家": "值或null",
    "期望时间": "值或null",
    "客户诉求": "值或null",
    "服务具体需求": "值或null",
    "病情或资料补充": "值或null",
    "特殊要求": "值或null",
    "沟通偏好": "值或null"
  },
  "workflowEvents": [
    { "code": "限定事件编码", "evidence": "明确事实依据" }
  ]
}
```

### 3.4 图片理解

文件：`packages/backend/src/llm/imageUnderstandService.ts`

触发条件：

- 订单 AI 分析前发现订单有尚未识别的图片素材。
- 图片下载后转为 JPEG/base64，再调用视觉模型。
- 成功后写入 `materials.aiImageKind`、`aiImageText`、`aiImageProcessedAt`。

实际提示词：

```text
你是医疗绿色通道服务的图片理解助手。员工会粘贴各种截图作为订单补充材料。
请判断图片类型，并提取其中的文字与关键信息。
类型只能取其一：聊天截图（微信/企业微信对话）、单据（挂号单/缴费单/检查单/病历等）、短信、其他。
提取要求：
- 聊天截图：按“谁说了什么”的顺序整理对话文字（分得清就标注说话人）。
- 单据：提取关键字段（医院、科室、医生、就诊时间、项目、金额、单号等）。
- 短信：照录短信正文与发件方。
- 看不清的字不要编造，照实留空或标注[不清晰]。
严格只输出一个 JSON：{"kind":"聊天截图|单据|短信|其他","text":"提取到的文字与关键信息"}。
不要解释、不要 Markdown、不要代码块标记。
```

user prompt 只有：`请按要求识别这张图片，只输出 JSON。`

### 3.5 身份证 OCR

文件：`packages/backend/src/services/orderIdCardOcr.ts`

触发条件：

- 订单来源为泰康。
- 存在 `fileType=40` 且为图片的身份证附件。
- 寰宇主表证件类型是身份证/儿童身份证，且已有号码为空或被脱敏。
- 每个订单通过 `order_id_card_ocr_attempts` 只占用一次识别机会。
- 当前实现只把 `attachments.slice(0, 4)` 发送给模型。

实际 system prompt：

```text
你只提取中国居民身份证人像面上的姓名和18位公民身份号码。
国徽面不含号码，必须忽略。
看不清或没有人像面时返回空字符串；不得猜测或补全。
只返回 JSON 对象 {"name":"","idNumber":""}。
```

实际 user prompt：

```text
这些是同一订单的身份证附件，请仅根据清晰的人像面提取姓名和身份证号码。
```

模型结果还会经过身份证校验码、姓名匹配和脱敏号码匹配，校验通过才写入远端寰宇主表。

### 3.6 旧版通话/消息/全单摘要

文件：`packages/backend/src/llm/summaryService.ts`

#### 单通电话摘要 `summarizeCall`

当前代码定义了该函数，但没有找到前端或路由直接调用；它不是当前主要通话沟通记录链路。

实际 system prompt：

```text
你是一个医疗服务行业的助理，负责帮助员工整理通话记录。
请用简洁的中文对通话内容做结构化摘要，包含：
1. 通话主要事项（1-3 条）
2. 客户诉求或问题
3. 跟进建议（如有）
输出纯文本，不要 Markdown，不要编造不在记录中的内容。
```

user prompt 会附上来电/去电、时长和完整 ASR 转写。

#### B 端通话沟通记录 `summarizeCallCommunication`

触发位置：

- `POST /api/v1/calls/:id/summarize`。
- `saveCallAsBOrderCommunication` 在电话已转写、没有已有摘要时可能触发。

提示词：

```text
你负责为医疗服务专员整理一通电话的沟通记录。
请只输出一段简短、客观的中文小结，控制在 1 至 3 句话，可概括客户诉求、双方确认事项和明确的后续安排。
只根据转写内容总结，不补造医院、时间、承诺或跟进事项；听不清或没有提到的内容不要猜。
不要输出标题、字段名、Markdown、通话结果或建议。
```

user prompt 会附上来电/去电、通话时长和完整 ASR 文本。

#### 微信消息摘要 `summarizeMessages`

触发位置：`POST /api/v1/orders/:id/messages/summarize`。当前前端没有找到对应调用。

实际 system prompt：

```text
你是一个医疗服务行业的助理。
请用简洁的中文对微信对话做结构化摘要，包含：
1. 对话主要事项
2. 客户关键诉求或情绪
3. 待跟进事项（如有）
输出纯文本，不要 Markdown。
```

user prompt：

```text
以下是与「conversationName」的微信对话记录，请生成摘要：

[时间] 发送人: 消息内容
...
```

风险：该接口按 `orderId` 取消息，而且把 `order.customerName` 当作 `conversationName`，与当前“申请号采集、一个申请号多订单”的数据模型不一致；它也没有同时传服务类型和同申请号其他订单上下文。

#### 全单摘要 `summarizeFull`

触发位置：`POST /api/v1/orders/:id/summarize`。当前前端没有找到对应调用。

实际 system prompt：

```text
你是一个医疗服务行业的订单跟进助理。
请根据以下订单的全部信息，生成一份简洁的跟进总结，包含：
1. 当前进展（2-4 句）
2. 客户核心诉求
3. 下一步建议行动
输出纯文本，不要 Markdown。字数控制在 300 字以内。
```

实际输入存在硬截断：

- 每通通话只取前 800 个字符。
- 消息全部拼接后只取前 1000 个字符，并不是“最近消息”。
- 订单详情 JSON 只取前 500 个字符。

这条链路不应承担完整字段提取或回填依据。

### 3.7 旧版关键信息抽取

文件：`packages/backend/src/llm/keyInfoService.ts`
接口：`POST /api/v1/ai/extract-key-info`

代码注释明确写着“接口已建好、可独立调，但不自动触发”。当前没有找到 Tray App、管理后台或插件调用它。

字段固定为：

- 陪诊人、陪诊人电话
- 意向医院、意向科室、意向医生
- 期望就诊时间
- 客户主诉或诉求
- 病情或诊断补充
- 特殊要求
- 联系或沟通偏好
- 其它关键点

system prompt 的核心要求：

```text
你是医疗绿色通道服务的信息抽取助手。下面是寰宇“服务专员(self)”与“客户(other)”的微信/企业微信对话。
注意：对话文字来自屏幕 OCR 识别，可能有错别字或个别字识别错误，请按语义合理理解，不要因个别错字影响判断。
请从对话中抽取“可回填到工单系统”的关键信息。
严格只输出一个 JSON 对象，不要解释、不要 Markdown、不要代码块标记。
没有的字段填 null，绝不编造；只写对话里明确出现或可合理确认的信息。
```

它只接收一个可选的简单订单上下文：客户、来源、意向医院、科室、业务；没有申请号、多订单列表、消息渠道、可靠时间和通话记录概念。因此它与当前新字段分析器功能重叠但业务边界更弱。

## 4. 现有提示词的主要问题

### P0：订单与申请号边界只写在提示词里，没有结构化输入保障

当前模型调用事实是：

- 消息和通话按申请号采集。
- 字段候选按订单写入。
- 同申请号可能有多个订单。
- 每次调用只显式告诉模型一张订单的服务类型。

提示词中虽然有“绝不把另一服务订单的信息写入本订单”，但模型没有看到完整的“同申请号订单清单”：每张订单的 ID、业务类型、基础医院/科室/医生、哪些信息属于哪张订单。对于“医院 A 是挂号订单，医院 B 是陪诊/检查订单”的交叉沟通，仅靠一句禁止语不足以稳定归属。

建议审查时把它作为第一优先级：模型输入应明确区分“申请号共享事实”“当前订单事实”“其他订单仅用于排除误归属的摘要”，并要求每个候选说明为什么属于当前订单。

### P0：新采集的结构化消息证据必须保持原样

原生微信/企微字段分析以采集器提供的 `occurredAt` 排序，并把该消息发生时间、方向、标准化类型、原始类型码和合并序号显式写入 AI 时间线。后台采集时间 `observedAt` 只用于静默和更新判断，不作为沟通事实发送给模型。旧截图消息仍保留原有 `sortTime ?? chatTime ?? capturedAt` 口径，因此需避免将两种来源的时间语义混为一谈。

### P1：字段白名单很详细，但业务定义不完全等于回填 Schema

`ORDER_AI_FIELD_DEFINITIONS` 已有大量字段和服务类型限制，这是当前最完整的业务规则来源。但仍需逐项核对：

- 字段 label 与泰康/寰宇真实回填字段是否一一对应；
- `hospital` 是最终履约医院还是客户初始意向；
- `appointment_success_time`、`outpatient_booking_success_time`、`inspection_appointment_success_time` 的业务事件和目标字段是否一致；
- `order_status`、`workflow_events`、B 端表单字段之间是否存在重复来源；
- `recommended_schemes` 是过程证据，不能被误当成最终医院；
- `escort_name/phone` 与 `escort_records` 的兼容字段是否会造成旧值覆盖新值。

### P1：简报与字段提取器职责重叠

`refreshOrderBrief` 每次会调用：

1. `buildOrderBrief`：生成面向员工阅读的阶段、摘要、风险、待办和粗粒度 keyInfo。
2. `extractOrderServiceFields`：生成可回填候选和工作流事件。

两套提示词都在判断医院、医生、陪诊人、时间、业务阶段，规则虽然部分重复，但输出口径不同。未来页面如果同时展示两套结果，必须明确：

- 简报只用于阅读和工作提醒；
- 字段候选才是回填候选；
- 简报不得作为自动回填或自动推进依据。

### P1：旧链路仍可生成不同口径结果

旧版摘要接口和旧版 `extractKeyInfo` 没有统一使用当前字段白名单，也没有完整的申请号/多订单上下文。即使现在前端没调用，也应明确标为废弃、限制用途，或移除入口，避免后续开发者误用。

### P1：证据表达不统一

新字段提取器要求 `evidence.source_id`，workflow event 却只保存一段 `evidence` 文本；简报的 `stageEvidence`、`risks`、`nextActions` 也没有强制来源 ID。对于回填审计，最好所有会影响业务状态的结论都带统一证据结构：来源类型、来源 ID、原始时间、排序时间、短引文、置信度。

### P1：存在输入截断和采样

审计时发现：

- 旧全单摘要截断通话、消息、订单详情。
- 身份证 OCR 只取前 4 个附件。
- 手工素材静默任务曾限制每轮处理 5 个订单；2026-10-28 调整后不再设置该数量上限。
- 旧简报扫描器每轮最多处理 5 个订单。

其中前两项会改变模型看到的事实范围；后两项主要影响处理时效，但应有明确的积压状态，不能让页面看起来像“没有异常”。

### P2：提示词和代码注释存在明显过期内容

例如：

- `refreshOrderBrief` 的注释仍称“增量”，实际调用把 `prevBrief` 传为 `null` 做全量重算。
- 历史数据库中的 `order_ai_schedule` 配置不再控制字段分析触发；当前自动触发规则为 ASR 完成即触发、微信/企微静默 5 分钟、手工补录静默 3 分钟。
- `orderBriefScheduler.ts` 仍描述旧的静默/消息条数简报调度，但 `index.ts` 当前启动的是 `startOrderAiSchedule`。

这些漂移会让维护人员误以为某条提示词已经在运行，或者误判 AI 调用频率。

## 5. 建议的后续整理方案

本次审计后的触发策略已于 2026-10-28 落地。其余建议按以下顺序处理：

1. **先确定唯一主链路。** 明确订单字段分析、订单简报、申请级简报和旧摘要接口的保留关系；旧接口若保留，标注“仅兼容/不用于回填”。
2. **继续维护来源明确的 AI 输入契约。** 原生消息提供准确发生时间、方向、类型、来源类型码和附件信息；旧截图消息使用其旧时间字段；不把系统采集时间混作消息发生时间。
3. **把提示词拆成稳定的业务规则和动态数据。** 业务规则集中维护；订单数据不要依赖自然语言一句“不能串单”，而要用明确的订单边界和输出约束表达。
4. **统一结论证据格式。** 任何候选字段、工作流事件、状态判断都必须可回指消息/通话/素材 ID；没有证据就返回空或 ambiguous。
5. **移除或隔离旧摘要链路。** 不要让旧接口继续产生看起来像正式结果的摘要，尤其不能把 `conversationName` 当作订单或客户边界。
6. **删除正式核心链路中的截断。** 如果确实需要上下文窗口控制，应实现明确的分页/分段/汇总策略并保留覆盖范围、失败状态和完整数据引用，不能直接 `substring` 或只取前几条。
7. **增加可复核记录。** 每次调用记录 prompt version、输入来源水位、订单/申请号、模型、原始返回、解析结果和失败原因；当前字段分析已有部分基础，应扩展到其他 AI 链路或明确它们不参与正式业务。

## 6. 代码索引

### 模型客户端

- `packages/backend/src/llm/gatewayClient.ts`
- `packages/backend/src/asr/funAsrClient.ts`

### 主要提示词

- `packages/backend/src/llm/orderAiExtraction.ts`
- `packages/backend/src/llm/orderBriefService.ts`
- `packages/backend/src/llm/imageUnderstandService.ts`
- `packages/backend/src/llm/keyInfoService.ts`
- `packages/backend/src/llm/summaryService.ts`
- `packages/backend/src/services/orderIdCardOcr.ts`

### 触发与编排

- `packages/backend/src/jobs/orderAiSchedule.ts`
- `packages/backend/src/jobs/orderBriefScheduler.ts`
- `packages/backend/src/jobs/orderBriefRunner.ts`
- `packages/backend/src/asr/transcribeScheduler.ts`
- `packages/backend/src/callCommunicationRecord.ts`

### HTTP 入口

- `packages/backend/src/routes/api.ts`
- `packages/backend/src/routes/admin.ts`

### 当前后台展示的订单 AI 配置

- `GET /api/v1/admin/order-ai-config`
- 该接口直接导出 `ORDER_AI_PROMPT_RULES`、字段白名单、输入说明和输出说明，后台页面不应再维护另一份提示词说明。
