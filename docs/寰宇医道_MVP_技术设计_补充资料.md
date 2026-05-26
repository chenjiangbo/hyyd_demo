# 寰宇医道 MVP 技术设计 - 补充资料

> 本文档是《寰宇医道 MVP 技术设计》的配套上下文。
> 主文档说"做什么、怎么做",本文档说"为什么是这样、环境怎么搭"。
> AI Coder 启动开发前**必须先读这份**,理解业务背景和已有的关键决策,避免自作主张。

---

## 第一部分:项目背景(为什么有这个项目)

### 1.1 寰宇医道是谁

寰宇医道是一家面向**保险公司**(主要客户:泰康人寿、平安保险)提供"医疗健康服务履约"的第三方服务机构。

它的业务本质**不是"挂号公司"**,而是:

> **保险公司权益履约 + 医疗资源协调 + 客户沟通服务 + 多系统操作 + 证据留痕 + 成本控制 + 后续结算支撑**

简单理解:保险公司的高净值客户买了带"就医增值服务"的保单。客户得了病,要找名医、要快速挂号、要陪诊、要住院协调,这些事保险公司不做,而是外包给寰宇这样的服务公司去履约。

### 1.2 两大核心业务

**业务一:名医挂号**
- 量大、单价低、相对标准化
- 但热门医院、热门科室、点名专家、指定日期等场景仍然不确定性高
- 部分医院平台有验证码、人脸识别、客户本人操作限制

**业务二:医疗绿通**(高净值权益)
- 围绕客户病情、保险权益、医院资源、线下服务能力的综合服务
- 一个绿通申请可能包含挂号、陪诊、护工、入院接送、住院协调等多个服务项
- 客户沟通多、服务过程长、凭证要求复杂、投诉追溯风险高

### 1.3 当前业务运转的痛点(老板祝总和吕总亲口说的)

1. **现有 ABI 系统只服务事后结算**,不撑过程交付。员工日常不在那里干活。
2. **员工每天要在 5-6 个系统之间来回搬数据**:泰康 PC、平安 APP、寰宇 ABI、个人微信、企业微信、电话、医院挂号小程序。
3. **数据全靠月底补录**——录音、截图、聊天记录,员工到月底才回头翻手机找,那时候人都忘了。
4. **员工不愿意额外录数据**——给绩效奖金都推不动。结论:**任何让员工"多填一点"的方案都会失败**。
5. **经验全在员工脑子里**——哪些医院难挂、哪个 APP 入口好用、什么时间放号,人走就丢。
6. **AI 想发挥作用,但没数据基础**——大模型很厉害,可寰宇连员工一天做了啥的数据都没有。

### 1.4 业务方提出的"硬约束"

经过和祝总、吕总沟通,以下几条是**红线**或明确的指导原则,不可违背:

- 🚫 **不做自动抢号**——RPA 模拟用户在医院网站抢号属于灰色地带,出事就是大事,业务方明确说不做
- 🚫 **不做大而全的业务系统**——先解决最痛的点,不要重做一套订单管理
- ✅ **无感采集**(吕总的核心主张)——员工"该怎么干还怎么干",数据由程序自动拿,自动匹配,自动回填,**最多在弹窗里确认一下**
- ✅ **无感回填**——员工和客户在微信沟通完,程序自动把要回填到泰康/平安的表单填好,员工核对一下点提交
- ✅ **预算 ≈ 40 万人民币 / 12 人月以内**,5 年回收
- ✅ **服务器在阿里云**(开发期在本地 Docker,生产期阿里云 ECS,无 RDS/OSS/ASR 等托管服务,**全部自建**)

### 1.5 这个项目要验证的核心命题

**"无感采集 + 无感回填"是否可以在不 hook 微信、不违反法律、不动客户基础设施的前提下实现。**

MVP 的全部价值就是把这件事**做出来给业务方看一眼**——员工只做"打电话、发微信、点申领"三个自然动作,其他全部由程序自动完成。

---

## 第二部分:关键技术决策的来龙去脉

> AI Coder 看到方案里某些选择"为什么不那样做"时,看这一节。

### 2.1 为什么不用 hook 微信/企微读消息

调研过 4 条路径:

| 路径 | 状态 | 为什么不用 |
|---|---|---|
| DLL 注入 / 内存 Hook(wxhelper 类) | 技术可行 | 违反腾讯 TOS;微信有 CCD 检测机制,可能封号;**杭州互联网法院 2020 年已有判例**,做微信辅助软件被判赔 260 万,商用风险大 |
| 本地数据库解密(PyWxDump 类) | 技术可行 | 同上;微信 4.x 数据库结构变更频繁,维护成本高 |
| UI Automation(微软标准 API) | 部分可行 | 微信 4.0 用 QT 重写后控件树严重残缺,实质退化为"截图 + OCR + 坐标点击" |
| 企业微信会话存档 API(腾讯官方) | **法律完全合规** | 但**寰宇员工用的是泰康的企业微信**,管理权在泰康,需要泰康开通接口给寰宇,商务推动慢 |

**结论**:走 **screenpipe 屏幕事件驱动采集**(法律和封号风险都极低,本质和"员工自己看屏幕"没区别)。中长期推动泰康开通会话存档作为补充。

### 2.2 为什么 screenpipe 不是 Pensieve / OpenRecall

调研过这一类的开源项目:

| 维度 | screenpipe | Pensieve | OpenRecall |
|---|---|---|---|
| 协议 | **MIT** ✅ | Apache-2.0 | AGPL-3.0 ⚠️ 商用毒性 |
| 采集策略 | **事件驱动**(应用切换/点击/键入才截) | 5 秒定时 | 定时 |
| 文本提取 | **Accessibility Tree 优先,OCR 兜底** | 纯 OCR | 纯 OCR |
| Stars | 18.9k | 1.4k | 2.8k |
| 应用过滤 | **录制时过滤**(allow/deny apps) | 黑名单(事后过滤) | 无 |
| 音频采集 | 内置 Whisper | ❌ | ❌ |

**为什么 screenpipe 赢**:

1. **事件驱动**对员工电脑长期运行至关重要——非工作时间、非目标应用都不耗资源
2. **Accessibility Tree 优先**意味着拿到的是结构化文本,不是 OCR 的脏文字,对企微/泰康这种结构化窗口有质的提升(假设 AT 能拿到)
3. **MIT 协议** = 商用零障碍
4. **录制时过滤** = 不在白名单的应用根本不截屏,符合"无感且不侵犯隐私"
5. **未来扩展性**:寰宇以后可能想加音频(电话会议)、键盘输入分析,screenpipe 都有,Pensieve 需要重新造

### 2.3 为什么泰康/平安不走 screenpipe,走浏览器插件

**关键事实:泰康和平安都是浏览器访问的 Web 应用(SPA),不是 PC 桌面应用。**

这意味着我们有比"截屏 + OCR"高一个数量级的选项——**直接读 DOM**。

| 能力 | screenpipe 屏幕采集 | Chrome 浏览器插件 |
|---|---|---|
| 拿到字段 | OCR/AT 推测,可能错 | **DOM 直读,100% 精确** |
| 监听用户操作 | 事件驱动捕获截图 | **addEventListener 实时** |
| 自动填表单 | ❌ 不可能 | **chrome.scripting 完美执行** |
| 上传文件到 input | ❌ | **可以(input type=file)** |
| 服务器登录态 | 不涉及 | **复用员工登录,无需服务器登录** |
| 法律风险 | 低 | 极低(浏览器扩展是 Chrome 官方机制) |

所以泰康/平安**只用浏览器插件**,完全不进 screenpipe 的视野。screenpipe 的应用白名单里**不要**包含浏览器进程,避免误采。

### 2.4 为什么 LLM 必须在服务器,不在客户端

**MVP 阶段已决定**:客户端**完全不跑 LLM**,所有文字提取、字段抽取、摘要生成全在服务器。

理由:

1. **员工电脑配置不能假设有 GPU**——跑 7B 中文 LLM 至少要 8GB 显存
2. **小 LLM 中文医疗效果不如大 LLM**——客户端跑 Qwen-1.5B 不如服务器调 GPT-4o
3. **客户端要瘦**——MVP 阶段所有逻辑要快速迭代,提示词改一行就要重新打包客户端 = 灾难
4. **OCR 例外**——screenpipe 用 Windows 系统原生 OCR(免费、中文开箱即用、零配置),这个保留在客户端做,但**不是 LLM**,只是 OCR

### 2.5 关于"自动登录"和"自动抢号"的边界

| 行为 | 状态 |
|---|---|
| 员工已登录后浏览器插件读 DOM | ✅ 做 |
| 员工已登录后插件自动点"申领"按钮 | ✅ 做(M3) |
| 员工沟通完后插件自动填回填表单(员工点提交) | ✅ 做 |
| 程序自动登录泰康 / 处理验证码 | 🚫 不做(员工手动登录) |
| 程序自动在医院网站抢号 | 🚫 业务方明令禁止 |
| 程序自动给客户群发微信 | 🚫 不做(法律和体验都不允许) |

---

## 第三部分:技术栈选型(及理由)

### 3.1 后端:Node.js + TypeScript + Fastify + Prisma

**结论:选 Node.js 不选 Python。**

| 比较项 | Node.js | Python (FastAPI) |
|---|---|---|
| 语言一致性 | 全栈 TypeScript(Electron / Chrome 插件 / 后端) | Python 后端 + TS 前端 |
| ML/AI 生态 | 弱 | 强 |
| async I/O | 原生最强 | 不错(asyncio) |
| Claude Code 输出质量 | TypeScript 输出质量极好 | Python 也好 |
| 部署 | Docker + node | Docker + uvicorn |

**关键判断**:寰宇 MVP 的后端**主要是 API 网关 + DB CRUD + 调外部 LLM/ASR HTTP API**,**完全不在后端跑 ML 推理**。Python 的 ML 优势用不到,而 Node.js 的"全栈一种语言"优势能省不少切换成本。

**具体选型**:

```
运行时:    Node.js 20 LTS
语言:      TypeScript 5.x (strict mode)
HTTP 框架: Fastify 4.x   (比 Express 快、JSON Schema 校验、TS 友好)
ORM:       Prisma 5.x    (TS 原生、PostgreSQL 一等公民、迁移工具好用)
WebSocket: @fastify/websocket 或 socket.io
日志:      pino (Fastify 默认)
任务队列:  BullMQ (Redis) - MVP 阶段可暂时不用,先单进程异步处理
配置:     dotenv + zod (强类型)
测试:     Vitest (MVP 阶段写少量关键测试,不强求覆盖率)
```

**补充说明**: 如果后续要自部署 FunASR,FunASR 本身是 Python,部署成独立 Docker 容器即可,通过 HTTP API 跟 Node 后端解耦。**不需要为此把整个后端换成 Python**。

### 3.2 数据库:PostgreSQL + MinIO(全部自建在 Docker)

**用户已指定,无需再选**。具体配置建议:

**PostgreSQL 16**
- 业务数据全部进这里
- **必装扩展**:`pgvector` (后续做语义检索)、`pg_trgm` (中文模糊匹配,LIKE 前补充)
- MVP 阶段单实例,生产期再考虑主从
- 数据卷挂载到主机持久化

**MinIO**
- S3 兼容对象存储,Docker 单实例
- **存储桶设计**(MVP 阶段):
  - `recordings/` — 通话录音
  - `screenshots/` — 微信/企微截图、泰康页面快照
  - `transcripts/` — ASR 文字结果存档
- **MVP 阶段不开启版本控制、生命周期管理**,先跑通
- **客户端直传**:服务端生成 STS 临时凭证(MinIO 兼容 AWS SDK),客户端 PUT 大文件直接到 MinIO,不经后端中转

**避免和其他项目的 Docker 容器冲突**(用户提到本机已有其他项目的 PG/MinIO):

```
寰宇专用容器命名前缀:huanyu-
端口映射用不冲突的:
  postgres: 15432:5432  (默认 5432 留给其他项目)
  minio:    19000:9000  (S3 API)
  minio:    19001:9001  (Console)
数据卷:    huanyu-pg-data / huanyu-minio-data
```

### 3.3 客户端存储(三端各自的)

**Tray App (Electron)**

- **better-sqlite3**(原生模块,同步 API,性能好,简单)
- 用途:
  - 离线消息队列(网络断了上传失败的数据本地缓存)
  - 配置项(Token、后端地址)
  - screenpipe 处理游标(last_processed_frame_id)
  - 最近 7 天的消息/帧缓存(便于工作台快速展示)
- 文件位置:`%LOCALAPPDATA%\寰宇采集客户端\local.db`

**Chrome 浏览器插件**

- **chrome.storage.local**(配置、状态、最近指令缓存)
- **IndexedDB**(如果要缓存大量订单数据,用 Dexie.js 封装)
- MVP 阶段优先 chrome.storage,数据量不大

**Android App**

- **Room**(Google 官方 SQLite 抽象,Kotlin coroutine 友好)
- 用途:
  - 录音上传队列(网络好时上传)
  - CallLog 同步游标
- 文件位置:App 私有目录 `/data/data/com.huanyu.collector/databases/`

### 3.4 LLM:OpenRouter

**用户已指定**。说明:

**OpenRouter 的优势**:
- 一个 API endpoint 路由到几十个模型
- 模型在请求 body 的 `model` 字段切换,代码零改动
- 统一计费,一个 key 全模型
- 国内访问需要中间代理(如果服务器在阿里云国内,需走海外节点)

**推荐模型(按场景)**:

| 场景 | 推荐模型 | 备注 |
|---|---|---|
| 微信消息字段抽取 | `deepseek/deepseek-chat-v3` | 中文好、便宜 |
| 录音转写文本结构化 | `anthropic/claude-3-5-sonnet` 或 `openai/gpt-4o` | 长上下文、推理强 |
| 订单全量摘要 | `anthropic/claude-3-5-sonnet` | 复杂综合任务 |
| 简单分类(是/否) | `google/gemini-flash-1.5` | 极便宜、够用 |

**集成方式**:

后端封装一个 `services/llm.ts`,统一接口 `llm.complete({ task, prompt, ... })`,内部按 task 类型选模型。这样模型切换、AB 测试都改一处。

**调用细节**:

- OpenRouter API 完全兼容 OpenAI SDK,直接用 `openai` npm 包,把 `baseURL` 改成 OpenRouter 即可
- 增加 `HTTP-Referer` 和 `X-Title` header(OpenRouter 用于统计,可选)

### 3.5 ASR(关键决策,后面单独一节)

**MVP 开发期**:**临时调通义听悟 API** 验证端到端流程
**MVP 演示期**:推荐已经切到 **FunASR Docker 自部署**
**正式上线**:必须自部署,见第四节详细论证

---

## 第四部分:ASR 选型详细论证

> 这块单拎出来讲,因为对寰宇业务影响大,选错代价高。

### 4.1 寰宇 ASR 的特殊性

寰宇的 ASR 输入有几个**和会议转写完全不同**的特点:

1. **8kHz 电话采样率**——手机通话录音是 8kHz,不是 16kHz。大多数 ASR 服务面向会议(16kHz),需要专门的电话场景模型
2. **中文医疗术语**——医院名、科室、疾病名、药品名密集出现,通用 ASR 准确率会断崖式下降
3. **单声道、双向音频**——员工和客户的声音混在一条音轨里(系统通话录音的特性),需要说话人分离
4. **录音质量参差**——客户用手机,信号、噪音、口音都不可控

### 4.2 候选方案对比

| 方案 | 中文准确率 | 8kHz 支持 | 医疗术语 | 可自部署 | 价格 |
|---|---|---|---|---|---|
| OpenAI Whisper API (large-v3) | 中等 | ✅ | 弱 | ❌(API) | $0.006/分钟 |
| Whisper 自部署 (large-v3) | 中等 | ✅ | 弱 | ✅ | 服务器电费 |
| 通义听悟 API | 高(声称 98%) | ⚠️ 需 ≥16kHz | 一般 | ❌(API) | 0.42 元/分钟 |
| 阿里云智能语音交互 | 高 | ✅ 有电话场景模型 | 可热词定制 | ❌(API) | 0.40 元/分钟 |
| **FunASR Paraformer-Large** | **高(达摩院,CER 比 Whisper 低 30-50%)** | ✅ | 可微调 | **✅** | 服务器电费 |
| FunASR SenseVoice-Small | 高 | ⚠️ 偏好 16kHz | 一般 | ✅ | 服务器电费 |

### 4.3 推荐方案:分阶段切换

**MVP 早期(第 1-3 周)**:用阿里云**智能语音交互-录音文件识别**(不是通义听悟,是另一个产品)
- 理由:它有专门的"电话场景模型"(`communication`),原生支持 8kHz,不需要重采样
- 0.40 元/分钟,MVP 阶段量很小,够用
- API 简单,3 小时能集成

**MVP 中后期(第 4 周开始)**:切到**自部署 FunASR(Paraformer-Large)**
- 阿里达摩院开源,**MIT 协议**,商用无障碍
- 中文 CER 比 Whisper 低 30-50%(公开数据集)
- 支持 8kHz 输入(通过 VAD 模型预处理)
- 现成 Docker 部署方案
- 内置说话人分离(CAM++)和标点恢复(CT-Transformer)
- 后续可以用寰宇自己的医疗对话数据微调

**不推荐通义听悟**的原因:
- 它强制 ≥16kHz,**电话录音 8kHz 必须重采样**,会损失高频信息,准确率反而下降
- 是面向会议场景的产品,不是电话场景
- 阿里云**智能语音交互产品线**才是面向电话场景的(同一个公司不同产品)

### 4.4 集成方式建议

**抽象层**:在后端 `services/asr.ts` 里写一个 `transcribe(audioOssKey)` 函数,内部按环境变量切换 provider:

```
ASR_PROVIDER=aliyun_nls    # MVP 早期
ASR_PROVIDER=funasr_local  # MVP 中后期 + 生产
```

调用方代码不变。

**FunASR Docker 部署要点**:

- 官方提供 `funasr/funasr-runtime-sdk-online-cpu-0.1.13` 这类镜像
- CPU 版可跑,但慢(RTF ~1.0,1 分钟音频处理 ~1 分钟)
- 加 NVIDIA GPU 后 RTF < 0.1(10 倍以上加速)
- MVP 阶段在本地 Mac 上**用 CPU 镜像即可**,生产阿里云上买带 GPU 的 ECS 实例(GN6i 起步)
- 服务化:FunASR 提供 WebSocket 流式接口和 HTTP 文件接口,寰宇用 HTTP 文件接口即可

### 4.5 8kHz 处理细节

不论用哪个方案,先做一步**音频标准化**:

```
原始 m4a (来自华为手机通话录音, 单声道, 8kHz AAC)
   ↓ ffmpeg
标准化 wav (单声道, 16kHz PCM, 16-bit)
   ↓ 送 ASR
转写结果
```

ffmpeg 命令模板:`ffmpeg -i input.m4a -ar 16000 -ac 1 -c:a pcm_s16le output.wav`

8kHz → 16kHz 重采样虽然不会增加信息,但能让所有 ASR 模型都接受输入,**且现代 ASR 在这个重采样数据上表现并不比原生 8kHz 模型差很多**(在阿里"通信"场景模型例外,它就吃 8kHz)。

---

## 第五部分:本地开发环境

### 5.1 Docker Compose 配置思路

为避免和你本机其他项目冲突,所有容器加 `huanyu-` 前缀,端口前缀用 `1xxxx`。

最小化 `docker-compose.yml` 结构:

```yaml
services:
  huanyu-postgres:
    image: pgvector/pgvector:pg16   # 内置 pgvector
    container_name: huanyu-postgres
    ports: ["15432:5432"]
    environment:
      POSTGRES_DB: huanyu
      POSTGRES_USER: huanyu
      POSTGRES_PASSWORD: huanyu_dev_pwd
    volumes:
      - huanyu-pg-data:/var/lib/postgresql/data

  huanyu-minio:
    image: minio/minio:latest
    container_name: huanyu-minio
    ports:
      - "19000:9000"   # S3 API
      - "19001:9001"   # Web Console
    environment:
      MINIO_ROOT_USER: huanyu
      MINIO_ROOT_PASSWORD: huanyu_dev_pwd
    command: server /data --console-address ":9001"
    volumes:
      - huanyu-minio-data:/data

  # 可选(MVP 早期不需要):
  huanyu-funasr:
    image: registry.cn-hangzhou.aliyuncs.com/funasr_repo/funasr:funasr-runtime-sdk-cpu-0.4.6
    container_name: huanyu-funasr
    ports: ["10095:10095"]
    profiles: ["asr"]   # 默认不启动,需要时 docker compose --profile asr up

volumes:
  huanyu-pg-data:
  huanyu-minio-data:
```

启动:
```
docker compose up -d huanyu-postgres huanyu-minio
# ASR 容器按需:
docker compose --profile asr up -d huanyu-funasr
```

### 5.2 后端连接配置

`.env.development`:
```
DATABASE_URL=postgresql://huanyu:huanyu_dev_pwd@localhost:15432/huanyu
MINIO_ENDPOINT=http://localhost:19000
MINIO_ACCESS_KEY=huanyu
MINIO_SECRET_KEY=huanyu_dev_pwd
MINIO_BUCKET_RECORDINGS=recordings
MINIO_BUCKET_SCREENSHOTS=screenshots

OPENROUTER_API_KEY=sk-or-v1-xxx
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

ASR_PROVIDER=aliyun_nls
ALIYUN_NLS_APPKEY=xxx
ALIYUN_NLS_TOKEN=xxx
# 后续切换:
# ASR_PROVIDER=funasr_local
# FUNASR_ENDPOINT=http://localhost:10095
```

### 5.3 初始化脚本建议

写一个 `scripts/init-dev.sh`,做这些事:
1. 启动 docker compose
2. 等 PostgreSQL ready
3. `prisma migrate dev`(执行迁移)
4. `prisma db seed`(灌入一个测试员工记录)
5. 在 MinIO 里建两个存储桶 `recordings` 和 `screenshots`
6. 打印连接信息

AI Coder 写后端时把这个脚本一起做出来,后续每个新人 onboard 跑一下就能开发。

---

## 第六部分:Mac 开发 + Windows 测试的工作流

### 6.1 整体策略:90% 在 Mac,10% 在 Windows

寰宇 MVP 的代码大部分**完全跨平台**:

| 组件 | 在 Mac 上开发的难度 |
|---|---|
| 后端 (Node.js + Docker) | ✅ 完全无差异 |
| Chrome 浏览器插件 | ✅ 完全无差异(Chrome 跨平台一致) |
| Electron App 代码逻辑 | ✅ 完全无差异(只是底层 API 调用有些不同) |
| Electron App 打包 Windows | ✅ Mac 上 `electron-builder --win` 跨平台打包,需要 wine |
| Android App | ✅ Android Studio 在 Mac 上完全 OK |
| screenpipe **行为** | ⚠️ Mac 上能跑,但 Mac 上的微信/企微 4.x 表现 ≠ Windows 上的 |
| **企微/微信集成验证** | ❌ **必须在 Windows 上做**(企微 PC 客户端的 UIA 树是 Windows-specific) |
| 泰康/平安网页插件验证 | ✅ 完全无差异(浏览器一致) |
| Android 通话采集 | ⚠️ 需要真机,但 Mac 也能 adb 连真机 |

**结论:整个 MVP 中,只有 M4(企微消息采集)和 M5(个人微信消息采集)的最终联调必须在 Windows 上**。其他 80% 的开发量在 Mac 上完成。

### 6.2 三种推荐工作流(按推荐度)

#### 方案 A(强推荐):Mac + Parallels Desktop Windows VM

- Mac 上装 **Parallels Desktop 20**(M 系列芯片用 Windows 11 ARM,这是微软官方支持的方案)
- 主开发环境在 macOS:VSCode、Claude Code、Docker、所有代码
- Windows VM 只装:Chrome、企业微信 PC、个人微信 PC、Node.js(用于跑 Electron 测试)
- 通过 Parallels 的"共享文件夹"功能,Mac 的项目目录直接挂载进 VM
- 开发循环:Mac 上改代码 → VM 里 `npm run dev` → 测试 → 改 → 回 Mac
- **Claude Code 始终在 Mac 上运行**,不需要在 VM 里装

**优点**:
- 一台机器搞定,不用切换物理机
- VM 可以快照,出问题秒回滚
- Parallels Desktop 有免费试用,确认好用再付费(年费 ~700 元)

**M 系列芯片需要注意**:
- Windows 11 ARM 通过 Prism 模拟 x64 应用,**企微/微信 PC 都能正常运行**
- screenpipe Windows 二进制是 x64,需要 Prism 翻译,**性能会有损失但功能 OK**
- 这正是我们要测的:在受限的 ARM Windows 上 screenpipe 表现如何,是更严格的验证

#### 方案 B:Mac 开发 + 物理 Windows 测试机(远程)

- 找一台旧 Windows 笔记本作为测试机,放在桌上或网络可达的地方
- Mac 上 VSCode + Claude Code 工作
- 通过 **GitHub** 同步代码(每次有需要 Windows 验证的改动就 push)
- Windows 测试机 pull 后跑测试
- 远程调试用 RDP(Mac App Store 有 "Microsoft Remote Desktop")

**优点**:
- 真实 x64 Windows,没有 ARM 兼容性问题
- Mac 性能不被 VM 抢占

**缺点**:
- 需要一台空闲 Windows 机器
- 来回切换效率低
- 不方便共享文件

#### 方案 C:全部搬到 Windows 开发

- Windows 11 + WSL2 + Claude Code(WSL2 里)
- 主开发体验确实不如 macOS

**不推荐**,除非你必须每天 8 小时盯着 Windows。

### 6.3 Claude Code 跨平台的具体说明

- **Claude Code 在 macOS 上原生运行良好**(Node + Anthropic API)
- **Claude Code 在 Windows 上需要 WSL2**(原生 Windows 终端体验受限)
- **方案 A 下**:Claude Code 跑在 Mac 上,VM 里只跑测试,Claude Code 不需要 Windows 配置
- **要让 Claude Code 帮你调试 Windows 专属问题**(比如 screenpipe 在企微上拿不到 AT):
  - 在 VM 里复现问题,把 screenpipe 的 log、API 返回的 JSON 复制粘贴到 Mac 上的 Claude Code 会话里
  - Claude Code 看到具体数据后能给出针对性建议
  - 这种"VM 跑测试 → 把现象贴回 Mac → Claude Code 分析"的工作流,实际效率比"AI 直接在 Windows 上跑"还高,因为问题描述更结构化

### 6.4 几个具体的工作流建议

**M1-M2 阶段(Chrome 插件 + 工作台基础)**:
- 100% 在 Mac 上做。Chrome 插件在 Mac Chrome 调试,Electron 工作台在 Mac 上跑
- 阶段结束做一次 Windows 兼容性烟囱测试

**M3 阶段(申领回流)**:
- 主体在 Mac 开发
- **必须在 Windows VM 里做最终验证**,因为员工实际场景是 Windows + 企业 Chrome 策略

**M4 阶段(企微消息)**:
- screenpipe Mac 二进制可以先用来联调 macOS 微信(Mac 也有微信 PC 版,虽然没企微)
- **真正验证必须在 Windows VM 里跑 Windows 企微 4.x + screenpipe Windows 二进制**
- 这个阶段你会高强度切换 Mac/VM,准备好 Parallels Coherence 模式无缝切窗口

**M5 阶段(个人微信)**:
- 同 M4

**M6 阶段(Android)**:
- Android Studio 全平台一致,Mac 直接做
- 测试用真机(华为手机),通过 USB 或局域网 adb 连

**M7 阶段(LLM 摘要)**:
- 100% 在 Mac 上做

### 6.5 项目结构对跨平台的支持

代码组织建议:

```
huanyu-mvp/
├─ packages/
│  ├─ shared-types/       # 全栈共享 TS 类型(订单/消息/通话等数据结构)
│  ├─ backend/
│  ├─ extension/
│  ├─ tray-app/
│  └─ android-app/        # Gradle 项目,独立打开
├─ docker-compose.yml
├─ docker-compose.asr.yml # 单独的 FunASR
├─ scripts/
│  ├─ init-dev.sh         # Mac/Linux
│  └─ init-dev.ps1        # Windows
├─ docs/
└─ pnpm-workspace.yaml    # 用 pnpm workspace 管理 monorepo
```

- 用 **pnpm workspace**(比 npm/yarn workspace 更快,Disk 占用小)
- 路径分隔符在代码里**永远用 `path.join()`**,不要硬编码 `/` 或 `\`
- 行尾用 `.gitattributes` 锁定 LF,避免 Mac/Windows 仓库冲突

---

## 第七部分:给 AI Coder 的额外指引

### 7.1 必须先读的关键技术验证点(每个里程碑开始前对照检查)

| 验证点 | 在哪个 M | 失败的话怎么 pivot |
|---|---|---|
| 泰康申领页 DOM 结构稳定可抓 | M1 | 改用 React DevTools API 读 Fiber 节点 |
| Chrome 插件能跨标签 chrome.scripting | M3 | 用 Native Messaging 或本地 WS server |
| screenpipe 在企微 4.x AT 能拿文本 | M4 | 退到 Windows OCR 路线(Pensieve 也一样)|
| screenpipe 应用白名单过滤生效 | M4 | 在我们的代码里按 app_name 二次过滤 |
| 华为通话录音文件路径稳定 | M6 | 启动时扫描多路径探测 |
| HarmonyOS 4.x 的权限申请流程 | M6 | SOP 文档化,运维一次性配置 |
| OpenRouter 在阿里云访问稳定 | M7 | 走代理或退到 DashScope |
| FunASR Docker CPU 性能够用 | M6/M7 | 临时切回阿里云 NLS API |

### 7.2 容易踩的坑(过来人经验)

1. **不要相信网上的"标准路径"**——Android 录音目录、微信安装目录,各品牌各版本都可能不同。**代码里写探测函数,不要硬编码**。

2. **不要在 content script 里写复杂业务逻辑**——content script 注入慢且不稳,把所有重逻辑放 background service worker 或后端。

3. **不要在第一版就上 WebSocket**——MVP 用 HTTP 短轮询足够,WebSocket 调试成本高,等基本流程跑通再升级。

4. **不要把 LLM 提示词写死在代码里**——把所有 prompt 放配置文件,改提示词不需要重新部署。

5. **不要省略错误处理**——网络断、API 429、文件损坏,**每个上传节点都要本地落盘 + 重试队列**,不然测试时丢数据查不出原因。

6. **不要让 Claude Code 一次性做多个里程碑**——一次一个 M,完成验收后再开下一个。否则它会过度抽象,改一个地方影响一片。

7. **不要在 MVP 阶段加用户登录系统**——Token 写死。等 MVP 通过、立项正式开发再补完整鉴权。

8. **不要在 MVP 阶段做 i18n / 主题切换 / 响应式**——全部硬编码中文,固定亮色,固定桌面尺寸。

### 7.3 验收标准的检查方式

每个 M 完成后,**业务方现场演示一遍**才算真通过,不要只看 demo 视频或截图。

演示脚本模板(每个 M 都写一个):

```
M1 演示脚本:
1. 我打开 Chrome
2. 我登录泰康(我自己手动登录,演示无法跳过)
3. 我导航到申领页
4. 我打开寰宇插件 popup
5. 我点"立即扫描"
6. 30 秒内,popup 显示"已上报 X 条订单"
7. 我打开 PostgreSQL 客户端,SELECT * FROM orders WHERE source='taikang'
8. 看到 X 条订单数据,字段完整
✅ 通过
```

业务方看不懂 SQL?那就让 AI Coder 顺手写一个最简单的查询页:`http://localhost:3000/admin/orders` 列表展示,业务方现场就能看到数据。

---

## 附录:启动检查清单

AI Coder 拿到任务后,第一天先做完这些再开始写业务代码:

- [ ] 看完《MVP 技术设计》主文档
- [ ] 看完本补充资料(尤其第一节业务背景和第二节关键决策)
- [ ] 在 Mac 上跑通 docker-compose,PostgreSQL 和 MinIO 都健康
- [ ] 在 Mac 上跑通后端骨架,能 `curl localhost:3000/health` 返回 ok
- [ ] 在 Mac 上跑通空的 Chrome 插件,能加载到 Chrome 里看到图标
- [ ] 在 Mac 上跑通空的 Electron App,能看到托盘图标
- [ ] OpenRouter 申请好 API Key,后端 `services/llm.ts` 能成功调用一次
- [ ] (如果有 Windows VM)能在 VM 里跑起来 screenpipe.exe,访问 `http://localhost:3030/health` 返回 ok
- [ ] 项目 Git 仓库建好,push 到 GitHub 私有库
- [ ] 整理一个《开发日志》文档,每天记录卡点和决策

以上完成才算 Week 1 的 M0 基础设施达成,可以进 M1。
