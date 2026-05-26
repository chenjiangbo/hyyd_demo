# 寰宇医道 数据采集 MVP 技术设计

> 本文档目的:给 AI Coder(Claude Code 等)作为开发输入,验证"无感采集 + 无感回填"技术方案的可行性。
>
> 本文档不是产品需求文档,不追求完整业务功能。MVP 阶段每个里程碑独立可演示、可推翻方案选型。

---

## 一、MVP 验证什么

MVP 要走通的端到端剧本(一个员工的一天):

1. 员工打开 Chrome,登录泰康后台,进入"申领"页面。我们的客户端**自动**读到这一页的所有候选订单。
2. 员工打开桌面上的"寰宇采集客户端"(托盘应用),进入"申领工作台"页面,看到刚才那批订单。
3. 员工在工作台上对某条订单点"申领"。浏览器插件**自动**切换到泰康标签页,点击该订单的申领按钮,并把申领后跳转的详情页数据采回。
4. 该订单出现在员工的"个人工作台"看板上。
5. 员工用工作手机(华为 HarmonyOS 4.x)拨打客户电话。挂断后,程序**自动**:
   - 拿到这次通话的元数据(号码、时长、时间戳)
   - 拿到系统自动录音的 m4a 文件
   - 上传到阿里云
   - 按号码匹配到该订单
6. 员工用企业微信添加客户的微信(企微的"外部联系人加客户微信"功能),发送"您好,您的挂号已完成 XXX"。程序**自动**抓到这条消息内容,关联到该订单。
7. 员工回到工作台,点开该订单详情页,看到:
   - 泰康原始数据
   - 通话记录 + 录音播放 + 录音转写
   - 微信对话内容 + 截图证据
   - LLM 对上述全部数据的中文摘要

**验证通过的判定**:以上 7 步全程**员工只做了"打电话、发微信、点申领"这三个自然动作**,其他全部由程序完成。

---

## 二、整体架构

```
┌─────────────── 员工 Windows PC ────────────────┐
│                                                 │
│ ┌──────────────────────────────────────────┐   │
│ │ 寰宇采集客户端 (Electron App)              │   │
│ │ ├ 托盘图标 + 状态                          │   │
│ │ ├ 工作台 UI (申领台 / 个人工作台 / 订单详情)│  │
│ │ ├ screenpipe.exe (子进程,采企微)          │   │
│ │ ├ 本地 SQLite 缓存                         │   │
│ │ └ 与阿里云的双向 HTTPS                     │   │
│ └──────────────────────────────────────────┘   │
│                                                 │
│ ┌──────────────────────────────────────────┐   │
│ │ Chrome 浏览器                              │   │
│ │ └ 寰宇浏览器插件 (Manifest V3)             │   │
│ │   ├ content script (注入泰康/平安域名)     │   │
│ │   ├ background service worker              │   │
│ │   └ 与阿里云的双向 HTTPS                   │   │
│ └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘

┌──────── 员工华为手机 (HarmonyOS 4.x) ──────────┐
│                                                 │
│ ┌──────────────────────────────────────────┐   │
│ │ 寰宇采集 App (Kotlin / 原生 Android)       │   │
│ │ ├ 前台服务保活                              │   │
│ │ ├ FileObserver 监听通话录音目录             │   │
│ │ ├ CallLog ContentProvider 同步             │   │
│ │ ├ WorkManager 后台上传                      │   │
│ │ └ 与阿里云的 HTTPS                          │   │
│ └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘

                          │
                          ▼ HTTPS
        ┌──────────────────────────────────────┐
        │ 阿里云后端 (Node.js / FastAPI 任选)    │
        │ ├ REST API (订单/沟通/录音/截图)       │
        │ ├ MySQL (业务数据)                      │
        │ ├ OSS (录音文件、截图)                  │
        │ ├ 通义千问 DashScope (LLM 抽取/摘要)    │
        │ ├ 阿里云 ASR (录音转写)                 │
        │ └ WebSocket / 短轮询 (向插件/客户端推令)│
        └──────────────────────────────────────┘
```

**关键架构决策(及理由)**:

1. **三端都直连阿里云,不在 PC 上做端到端通信**。
   - 浏览器插件、Tray App、手机 App,各自跟阿里云说话
   - 工作台"点申领" → Tray App POST 云端"待执行指令" → 云端用 WebSocket 推给插件 → 插件执行 → 完成后 POST 结果给云端 → 云端推给 Tray App
   - 好处:每个组件独立部署、独立测试,不需要 Native Messaging 注册表那套
   - 坏处:操作延迟 1-2 秒,MVP 可接受

2. **Tray App = Electron**。
   - 工作台 UI(React)和后台采集逻辑(Node.js)在同一进程,简单
   - 跨平台基础好,后续要扩 Mac 不用重写
   - screenpipe.exe 作为 child_process 启动,生命周期跟 Electron 主进程绑定

3. **screenpipe 作为黑盒嵌入,不改源码**。
   - 通过 spawn 启动,通过它的 REST API 取数据
   - 配置只采特定应用窗口(`WeChat.exe`、`WXWork.exe` 等),其他全部 deny
   - 数据目录指定到我们的 app data 下

4. **所有 LLM 推理在服务器**,客户端只搬数据。

5. **MVP 阶段不做用户认证**。
   - 后端用一个固定的 API Key 写死在客户端配置里,标识"哪个员工"
   - 上线前再加完整账号体系

---

## 三、技术栈

| 组件 | 技术栈 | 备注 |
|---|---|---|
| Tray App | Electron 30+ + React 18 + TypeScript | UI 用 React + Tailwind,后台逻辑用 Node.js |
| 屏幕/AT 采集 | screenpipe CLI(嵌入) | 用 release 二进制,不编译源码 |
| 浏览器插件 | Chrome Extension Manifest V3 + TypeScript | 兼容 Edge |
| Android App | Kotlin + AndroidX | 最低 Android 10,目标 14 |
| 后端 | Node.js (Express/Fastify) 或 Python (FastAPI) | 任选,本文档示意用 Node |
| 数据库 | MySQL 8(阿里云 RDS) | 业务数据 |
| 对象存储 | 阿里云 OSS | 录音、截图 |
| LLM | 阿里云 DashScope(通义千问 qwen-turbo / qwen-plus) | 中文医疗场景效果好,按量计费 |
| ASR | 阿里云智能语音交互(录音文件识别) | 中文专科识别准确率高 |
| 实时推送 | WebSocket(后端用 ws / socket.io) | 推"待执行指令"给插件 |

---

## 四、共享基础设施 (M0,任何里程碑前先做完)

### 4.1 后端骨架

最小可用 REST + WebSocket 服务:

**REST 端点(只是骨架,各里程碑会扩):**
```
POST /api/v1/orders                     上报订单
GET  /api/v1/orders?source=taikang      查询订单
POST /api/v1/orders/:id/claim           工作台触发申领
GET  /api/v1/commands?client=ext        插件轮询待执行指令(WS 升级)
POST /api/v1/commands/:id/done          指令完成回报
POST /api/v1/messages                   上报微信消息
POST /api/v1/calls                      上报通话记录
POST /api/v1/recordings                 上传录音(OSS 直传 STS 签名)
POST /api/v1/screenshots                上传截图
GET  /api/v1/orders/:id/aggregate       订单详情聚合(给工作台用)
POST /api/v1/llm/summarize              触发 LLM 摘要
```

**鉴权:** 每个客户端配置里写一个 `X-Employee-Token`,后端用一张表查映射(员工 ID、姓名、手机号、绑定的微信号等)。MVP 阶段员工记录手工 INSERT 即可。

**数据库表(MVP 最小集):**
```
employees                  员工
  id, name, phone, wechat_id, taikang_account, token

orders                     订单(汇集所有来源)
  id, source(taikang/pingan/...), source_order_no,
  customer_name, customer_phone, hospital, dept, doctor,
  status(候选/已申领/进行中/完成),
  assigned_employee_id, raw_json, created_at, updated_at

messages                   微信/企微消息
  id, order_id?(可空,关联不上时空), channel(wechat/wxwork),
  conversation_name, sender_name, content_text,
  screenshot_oss_key, captured_at, employee_id

calls                      通话记录
  id, order_id?, employee_id, phone, direction(in/out),
  duration_sec, started_at, recording_oss_key,
  asr_text?, asr_status

commands                   待执行指令(给插件)
  id, target(ext/tray), action(claim/fill_form/...),
  payload_json, status(pending/done/failed),
  created_at, executed_at

ai_summaries               LLM 生成的摘要
  id, order_id, type(call/message/全量),
  content, model, created_at
```

**OSS 直传:** 客户端不通过后端中转大文件,后端发 STS 临时签名,客户端直接 PUT 到 OSS。

### 4.2 工作台 UI 骨架(Electron 内嵌)

两个核心页面 + 一个详情页:

- **申领台** (`/intake`):表格展示所有 `status=候选` 的订单,带"申领"按钮
- **我的工作台** (`/my-workbench`):看板视图,展示 `assigned_employee_id=当前用户` 的订单,按状态分列
- **订单详情** (`/order/:id`):聚合页,见 M6

UI 用 React + Tailwind,数据全从 `GET /api/v1/orders` 拉,**MVP 阶段不做缓存、不做实时刷新,手动刷新按钮即可**。

### 4.3 项目结构建议

```
huanyu-mvp/
├─ backend/                  Node.js + Express + WebSocket
│  ├─ src/
│  │  ├─ routes/
│  │  ├─ models/             Sequelize/Prisma
│  │  ├─ services/llm.ts     封装 DashScope
│  │  ├─ services/asr.ts     封装阿里云 ASR
│  │  └─ ws/                 WebSocket 指令推送
│  └─ docker-compose.yml     本地起 MySQL
│
├─ extension/                Chrome 插件
│  ├─ src/
│  │  ├─ background.ts       service worker
│  │  ├─ content/taikang.ts  泰康域名注入脚本
│  │  ├─ content/pingan.ts   平安域名注入脚本
│  │  └─ popup/              调试用弹窗
│  └─ manifest.json
│
├─ tray-app/                 Electron 客户端
│  ├─ main/                  主进程
│  │  ├─ index.ts
│  │  ├─ screenpipe-runner.ts  spawn + 健康监控
│  │  └─ uploader.ts
│  ├─ renderer/              工作台 UI (React)
│  └─ resources/
│     └─ screenpipe.exe      打包进资源
│
├─ android-app/              Android (Kotlin)
│  └─ app/src/main/...
│
└─ docs/
   └─ 本文档
```

---

## 五、验证里程碑(每个独立可演示)

> 每个里程碑都设计成**只验证一个技术点**,失败也只影响这一个里程碑,可以单点 pivot 不影响其他。

### M1 浏览器插件读取泰康申领页订单列表

**目标:** 在员工已登录的泰康标签页里,插件能把申领页面的所有订单数据,**结构化**地推送到后端。

**前置条件:**
- M0 完成
- 员工手动在 Chrome 里登录好泰康(MVP 阶段不做自动登录)
- 已知泰康申领页 URL pattern(开发时由你这边提供一个真实可见的样本,或拿一个员工电脑实际操作录屏给开发者参考)

**实现思路:**

1. **manifest.json 配置 host_permissions** 指向泰康域名 (`https://泰康域名/*`)
2. **content script 注入策略**:
   - 用 `matches` 字段匹配申领页 URL 模式
   - 注入后等待页面 DOM 稳定(用 `MutationObserver` 监听订单表格容器,而不是固定 setTimeout)
   - **关键挑战**:泰康可能是 SPA,路由切换时 content script 不会重新注入。解决方案:用 `chrome.webNavigation.onHistoryStateUpdated` 监听 URL 变化,通过 `chrome.scripting.executeScript` 二次注入
3. **数据抓取**:
   - **不要用 CSS class 选择器**(类名通常是 hash 化的、会变)
   - 优先用**结构特征 + 文本特征**:比如"包含'订单号'三个字的标签的兄弟节点的文本"
   - 或者打开泰康页面的 React/Vue devtools 查找组件 props,如果能拿到 React Fiber 节点,直接读 props 最稳
   - 把每条订单抓成 `{ source_order_no, customer_name, hospital, dept, doctor, ... }` JSON
4. **推送后端**:
   - background service worker 通过 `fetch` POST 到 `/api/v1/orders` 批量上报
   - 带上 `X-Employee-Token`(从 `chrome.storage.local` 读,首次安装时让员工填一次)
5. **去重**:后端按 `(source, source_order_no)` 做 upsert

**实现思路上需要 AI Coder 注意的:**

- **泰康 DOM 结构未知,这部分代码必须"探针 + 适配"模式**:先写一个调试模式,把抓到的 DOM 结构(简化版)dump 出来给开发者看,根据实际页面再调整选择器
- **加一个开关**:`chrome.storage` 里存一个 `debug=true`,开启时在控制台打详细日志、不真正上报后端,方便联调
- **避免被泰康网站当作爬虫**:不要用 setInterval 高频扫描,只在页面打开/路由切换/用户手动点"刷新"时触发抓取

**验收标准:**
- 员工打开泰康申领页 5 秒内,后端 `orders` 表里出现完整数据
- 控制台无报错
- 同一员工重复打开页面不会产生重复订单
- 关掉插件,泰康页面操作不受影响

**已知风险:**
- 泰康可能用 iframe 嵌套真实业务页面,需要在 manifest 里加 `"all_frames": true`
- 如果泰康有 React/Vue,真实数据可能在 props 里而 DOM 文本只是渲染结果,优先读 props
- 字段命名差异:第一次先全部抓出来再按业务字段映射,不要在 content script 里硬编码字段名

---

### M2 工作台展示订单 + 看板雏形

**目标:** Tray App 安装后,打开工作台能看到 M1 上报的订单,可以按"候选/已申领"两态展示。

**前置条件:** M0、M1 完成

**实现思路:**

1. **Electron 项目初始化**:用 `electron-vite` 模板,主进程 + 渲染进程都 TypeScript
2. **托盘集成**:启动后只显示托盘图标(不开窗口),点击图标弹出工作台主窗口;关闭窗口时只隐藏不退出
3. **首次配置**:首次启动弹一个简单对话框,让员工填:
   - 员工 Token(后端给的)
   - 后端地址(默认 `https://后端.aliyun.com`)
   - 这些存到 Electron 的 userData 目录里
4. **工作台 UI**:
   - 申领台页:一个表格,列 = 订单号/客户/医院/科室/医生/操作。"操作"列一个"申领"按钮
   - 我的工作台页:三列看板(已申领/进行中/完成),卡片样式
   - 状态切换、刷新按钮、底部状态栏(显示"已连接/未连接"、最后同步时间)
   - **UI 尽量简陋,样式抄 shadcn/ui 的默认即可,MVP 不做美化**
5. **数据获取**:每次进入页面调一次 `GET /api/v1/orders?status=候选&employee_id=自己`,不做实时推送、不做缓存

**验收标准:**
- Tray App 安装后,Windows 任务栏右下角有寰宇图标
- 双击图标弹出工作台,能看到 M1 上报的订单
- 切换页面顺畅,不卡死
- 关闭窗口后再次点击图标能重开

**已知风险:**
- Electron 打包后可能被 Windows Defender 误报,MVP 阶段不签名也可以,但要在文档里告诉测试用户怎么允许
- Electron 默认会展示 menu bar,记得隐藏掉

---

### M3 工作台→插件→泰康申领回流

**目标:** 在工作台点"申领",浏览器插件**自动**在泰康页面点击该订单的申领按钮,并把申领后的订单详情页数据回推。

**这是 MVP 最关键的一步,验证"无感操作回流"是否可行。**

**前置条件:** M1、M2 完成

**实现思路:**

1. **工作台点"申领"**:
   - POST `/api/v1/orders/:id/claim` 携带 `employee_id`
   - 后端创建一条 `commands` 记录:`{ target: 'ext', action: 'claim', payload: { source_order_no, ... } }`
2. **后端 → 插件 推送**:
   - 插件 background service worker 启动时建立 WebSocket 连接到 `/ws?token=xxx&client=ext`
   - 服务端按 `employee_id` 维护连接,有新指令直接推
   - **降级方案**:WebSocket 失败时,插件改用 5 秒短轮询 `GET /api/v1/commands?status=pending`
3. **插件执行 claim**:
   - 收到指令后,先 `chrome.tabs.query` 找泰康申领页标签
   - 找不到则 `chrome.tabs.create` 新开一个(MVP 阶段假设员工已经登录、tab 存在;找不到就报错,把状态回写后端"需要员工手动打开泰康")
   - `chrome.scripting.executeScript` 在该标签里执行点击逻辑:
     - 根据 `source_order_no` 在 DOM 里定位对应行
     - 找到该行的"申领"按钮,`button.click()`
     - 等待跳转(用 `MutationObserver` 或轮询新 URL)
   - 跳转到详情页后,抓取详情数据
   - POST 详情数据到 `/api/v1/orders/:id`(更新原订单状态为已申领 + 补全详情字段)
   - POST `/api/v1/commands/:id/done` 回报指令完成
4. **工作台刷新**:
   - 工作台等待 3 秒后自动 GET 订单状态,或服务端通过 WebSocket 通知 Tray App 该订单已更新
   - 订单从"申领台"页消失,出现在"我的工作台"

**实现思路上需要 AI Coder 注意的:**

- **关键失败模式**:申领按钮可能弹确认对话框、可能要选医生、可能要填日期。**MVP 阶段先验证"能点到、能跳转",不处理这些分支**。遇到分支就回报指令"需要人工",把指令状态设为 `requires_manual`,工作台上提示员工手动处理
- **错误回退**:点击没反应、找不到行、超时,都要把 `commands` 记录设为 `failed` 并附带原因,工作台显示给员工
- **避免误点**:在 content script 里加防御性检查——只点带预期 `data-* 属性`或文本"申领"的按钮,不要泛匹配
- **录屏调试**:开发期间,在插件执行 claim 时把过程截图发到后端(可选,辅助调试)

**验收标准:**
- 工作台点"申领"后 < 5 秒,泰康标签页中对应订单状态变为"已申领"
- 后端订单状态正确流转
- 工作台对应订单从申领台消失、出现在我的工作台
- 失败时工作台能看到失败原因
- 切换到其他订单点申领、批量点申领,不互相干扰

**已知风险:**
- **泰康可能有"二次确认"弹窗**,需要插件再点一次"确认"。这个具体取决于泰康设计,先验证最简单的"无弹窗"场景
- **泰康可能限制申领频率**,密集点会触发风控。MVP 阶段员工手动一条一条点,不密集

---

### M4 企业微信消息采集

**目标:** 员工通过企业微信和客户聊天,程序自动采到消息文本 + 截图,推到后端,关联到对应订单。

**前置条件:** M0、M3 完成(订单库里有数据可以关联)

**实现思路:**

1. **screenpipe 集成**:
   - 把 `screenpipe.exe` 放到 Electron 的 `resources/` 目录
   - 主进程启动时 spawn 它,关键启动参数:
     - `--port 17890`(只对本进程可见的随机端口也行,固定方便调试)
     - `--data-dir <userData>/screenpipe-data`
     - `--disable-audio`(MVP 不录音)
     - `--ignored-windows "*"`(默认全部忽略)
     - 然后通过 API 或额外参数把 `WeChat.exe`、`WXWork.exe` 加白名单(具体参数名以 screenpipe 当前版本 `--help` 输出为准)
     - **如果命令行不支持只采指定 app,降级方案**:全采,在我们的处理代码里按 `app_name` 字段过滤,只处理这两个
   - 监控子进程:崩了自动重启,日志写到我们的 log 文件
2. **轮询 screenpipe API**:
   - 主进程开一个定时任务,每 10 秒调一次:
     ```
     GET http://127.0.0.1:17890/search?content_type=all
         &app_name=WXWork.exe&start_time=<上次游标>
     ```
   - 维护一个 `last_cursor` 持久化到本地
3. **消息提取**:
   - screenpipe 返回结构: `{ frame_id, timestamp, app_name, window_name, ocr_text, accessibility_text, image_path }`
   - **优先用 accessibility_text**(企微 4.x 是 QT,有部分 UIA 控件树,先看实际能拿到什么程度)
   - 不行就用 `ocr_text`(Windows 原生 OCR 中文支持开箱即用)
   - 把"会话名 / 大致消息内容 / 时间戳 / 截图路径"提取出来
   - **MVP 阶段不在客户端做精细解析**(发件人、消息分段都靠服务端 LLM 做),客户端只搬运
4. **上传**:
   - 截图先用 OSS STS 签名直传,拿到 `oss_key`
   - 然后 POST `/api/v1/messages` 带上 `{ channel: 'wxwork', conversation_name, raw_text, screenshot_oss_key, captured_at, employee_id }`
5. **后端订单关联**:
   - 收到 message 后,后端用 `conversation_name`(可能是客户姓名)+ `employee_id`(谁在沟通)模糊匹配最近的订单
   - 匹配上就写 `order_id`,匹配不上就放 `order_id=NULL`,等人工或后续 LLM 处理时补

**实现思路上需要 AI Coder 注意的:**

- **先单独验证 screenpipe 在企微 4.x 上能拿到什么**:让开发者**第一步不写集成代码,先手动运行 screenpipe,打开企微聊天,然后 curl `localhost:3030/search` 看返回数据**。如果 accessibility tree 拿不到文本,就提前知道要走 OCR 路线
- **OCR 准确率验证**:让 screenpipe 跑 1 小时企微聊天,把 OCR 文本和截图对照,人工评估准确率。低于 80% 要考虑换 PaddleOCR 等中文专项 OCR
- **隐私边界**:不止采企微,也要避免误采其他应用。app 过滤一定要严
- **企微截图也要采**:除了文字,有些场景需要截图作证据,screenpipe 默认就是有截图的,把 image_path 一并上传 OSS

**验收标准:**
- 员工和测试客户在企微聊天 10 分钟后,后端 `messages` 表至少有这次会话里的全部消息文本
- 至少 80% 消息能正确关联到订单
- 不采集任何非企微/微信窗口的内容(验证方法:开个浏览器看新闻,后端不应该出现该网页内容)

**已知风险:**
- **企微 4.x 的 accessibility tree 可能不可靠**,OCR 准确率成为成败关键
- **多个企微聊天窗口同时打开**:screenpipe 抓到的是当前激活窗口,如果员工快速切换会话,可能有消息漏抓。MVP 不解决,记录为已知缺陷

---

### M5 个人微信消息采集(轻量验证)

**目标:** 和 M4 一样,但验证个人微信 4.x 客户端能否被 screenpipe 采到。

**前置条件:** M4 完成

**实现思路:** 完全复用 M4 代码,只是把 app 白名单加上 `WeChat.exe`。

**验收标准:** 个人微信聊天文本能进 `messages` 表,`channel='wechat'`。

**说明:** M5 不需要单独做,M4 跑通后这个基本顺带就好了。如果个人微信 4.x 的 OCR/AT 比企微更差,记录下来,后续考虑专项处理。

---

### M6 安卓通话采集(华为 HarmonyOS 4.x)

**目标:** 员工用工作手机打电话给客户,挂断后,后端能拿到:
- 通话记录元数据(号码、时长、时间戳)
- 通话录音 m4a 文件
- 录音 ASR 文本

**前置条件:** M0 完成

**实现思路:**

1. **Android App 主结构**(Kotlin):
   - 一个 ForegroundService 常驻,通知栏写"寰宇业务采集运行中"
   - Application onCreate 里启动该 Service
   - AndroidManifest 配 `BOOT_COMPLETED` 接收器,开机自启
2. **一次性手机配置(运维 SOP,不是代码)**:
   - 设置 → 电话 → 通话自动录音 → 开启
   - 应用启动管理 → 寰宇采集 → 允许自启 + 允许后台运行 + 关闭电池优化
3. **CallLog 同步模块**:
   - `ContentResolver.query(CallLog.Calls.CONTENT_URI, ...)`,字段:`NUMBER, TYPE, DATE, DURATION, CACHED_NAME`
   - 维护 `last_call_log_ts` 增量同步
   - 触发时机:① App 启动 ② `PhoneStateListener` 收到 `CALL_STATE_IDLE` 即通话结束 ③ 每 15 分钟兜底
   - 同步到后端 POST `/api/v1/calls`
4. **录音文件监听**:
   - 华为 HarmonyOS 4.x 通话录音默认路径:`/storage/emulated/0/Sounds/CallRecord/`(也可能是 `/storage/emulated/0/record/callrecord/`,App 启动时扫一遍探测)
   - 文件名通常包含号码和时间戳,格式如 `通话录音 13800138000 20260525143020.m4a`,解析出号码和时间
   - 用 `FileObserver` 监听 `CLOSE_WRITE` 事件
   - 新文件出现后等 3 秒(确保系统写完),然后:
     - 解析文件名拿到号码和时间
     - 在本地 SQLite 里查最近 5 分钟内同号码的 calls 记录,关联起来
     - 用 OSS STS 签名直传文件
     - POST `/api/v1/recordings` 带上 `call_id, oss_key, duration_sec`
5. **服务端 ASR**:
   - `/api/v1/recordings` 触发后台任务,提交到阿里云语音转写
   - 转写完成后写入 `calls.asr_text`,状态 `asr_status='done'`
6. **权限申请**:
   - `READ_CALL_LOG`、`READ_PHONE_STATE`、`READ_MEDIA_AUDIO`(Android 13+) 或 `READ_EXTERNAL_STORAGE`(Android 10-12)
   - `FOREGROUND_SERVICE`、`POST_NOTIFICATIONS`、`RECEIVE_BOOT_COMPLETED`
   - 鸿蒙 4.x 基于 AOSP,这些标准权限都适用;但 HarmonyOS 可能多一层"管控类权限",App 第一次启动后要在系统设置里手动二次确认,SOP 文档要说明

**实现思路上需要 AI Coder 注意的:**

- **先单独验证录音路径**:让开发者写一个最小 App,只跑"扫描 `/storage/emulated/0/` 下所有可能的录音目录,打印文件列表",在测试机上实际测出录音真实路径。**不要相信网上的路径列表**,各厂商各版本有变化
- **CallLog 字段在国行 ROM 可能被定制**:实际测试时把所有字段都打印出来核对
- **未接通的电话**:CallLog 里 TYPE=3(未接) 或 TYPE=5(拒接),也要同步,这是寰宇要的"留痕证据"
- **录音可能滞后**:有些机型录音文件是通话挂断后 5-10 秒才写完,FileObserver 的 `CLOSE_WRITE` 是可靠信号

**验收标准:**
- 员工拨打测试客户号码,挂断后 30 秒内,后端 calls 表有这条记录、recordings 表有 OSS 链接
- 录音文件能下载下来播放,音质正常
- ASR 完成后 calls.asr_text 有中文转写
- 未接通的电话也有 calls 记录(标记 `direction='out', duration_sec=0`)

**已知风险:**
- 鸿蒙 4.x 的"纯血鸿蒙" vs "兼容 AOSP 鸿蒙"差异:寰宇员工的机器需要确认是哪种。**纯血鸿蒙 5.0 不再兼容 Android APK,但 4.x 仍然兼容**,所以 MVP 没问题
- 后续要兼容小米、OPPO 等,只是加路径映射

---

### M7 订单详情聚合页 + LLM 摘要

**目标:** 工作台订单详情页能看到这一个订单的所有数据,且有 LLM 自动生成的摘要。

**前置条件:** M1-M6 全部完成(或部分完成,有数据就行)

**实现思路:**

1. **后端聚合 API** `GET /api/v1/orders/:id/aggregate`:
   - 一次性返回:订单基础信息 + 所有关联的 messages + 所有 calls(含录音 URL 和 ASR 文本) + 所有 screenshots + 现有的 ai_summaries
   - 用 SQL JOIN 一次取出,前端不拆多次请求
2. **工作台详情页 UI**:
   - 顶部:订单基础信息卡片
   - 左半边:时间线(messages 和 calls 按 captured_at 混合排序),每条记录展开看详情、缩略图、播放器
   - 右半边:**AI 摘要面板**
   - 底部:"重新生成摘要"按钮
3. **LLM 摘要逻辑**(`POST /api/v1/llm/summarize`):
   - 拿到该订单所有消息文本 + ASR 文本,拼成一个 prompt
   - 调通义千问(DashScope) `qwen-plus`,prompt 模板大致:
     ```
     你是医疗服务订单分析助手。下面是一个订单的所有沟通记录:
     [订单信息]
     [按时间排序的所有消息和通话转写]
     请输出:
     1. 客户的核心需求(医院/科室/医生/日期/特殊要求)
     2. 当前进度(已沟通什么、待确认什么)
     3. 异常或风险提示(如客户不满、要求超出权益等)
     4. 下一步建议动作
     用中文,简洁,不要套话。
     ```
   - 把结果写入 `ai_summaries` 表
4. **触发时机**:
   - MVP 阶段:员工点"生成摘要"按钮手动触发
   - 后续:每次有新 message/call 进来,自动入队后台生成

**实现思路上需要 AI Coder 注意的:**

- **prompt 工程**:第一版别想着调到完美,只要输出"看得过去"就行,迭代留到 MVP 后
- **成本**:qwen-plus 中文 1M token 大约 4 元,一个订单的全量上下文不会超过 5K token,可控
- **缓存**:同一订单数据没变就不重新调 LLM,前端读 `ai_summaries` 表里已有的

**验收标准:**
- 详情页能看到一个订单的全部 7 类数据(基础信息 / 来源原始数据 / 微信消息 / 企微消息 / 通话记录 / 录音 / 截图)
- 点"生成摘要"后 10 秒内出结果
- 摘要内容能反映真实沟通情况,不胡编(找 5 个真实订单跑一遍,人工评估)

---

## 六、MVP 不做的事(明确划清边界)

为防止 AI Coder 在 MVP 阶段过度设计,以下事项**明确不做**:

- ❌ 多租户、用户登录注册、权限管理 → 用 Token 写死
- ❌ 高可用、负载均衡、灾备 → 单机阿里云 ECS 即可
- ❌ 性能优化、压力测试、缓存层 → 数据量极小
- ❌ 漂亮的 UI、动画、品牌设计 → shadcn 默认样式即可
- ❌ 完整业务流程(订单生命周期管理、状态机) → 只验证"候选→已申领"两态
- ❌ 后端 ABI 系统对接 → 数据闭环在我们自己后端里完成
- ❌ 自动化测试套件(单测/e2e) → 手工演示通过即可
- ❌ 国际化、暗色模式、无障碍 → 全部中文,亮色
- ❌ 微信/企微 hook、内存解密、协议逆向 → 只用 screenpipe 屏幕采集
- ❌ 平安 APP 采集 → MVP 只验证泰康,平安结构类似复用
- ❌ 自动登录泰康/平安 → 员工手动登录
- ❌ 浏览器插件离线工作 → 必须连后端
- ❌ Android 端的微信/企微采集 → 只在 PC 端做
- ❌ iOS → 不支持

---

## 七、给 AI Coder 的启动指引

### 7.1 推荐开发顺序

1. **Week 1**: M0 后端骨架 + 数据库 + 项目结构(全栈最小可跑)
2. **Week 2**: M1 + M2(打通 Chrome 插件 → 后端 → Tray App 工作台展示链路)
3. **Week 3**: M3(最关键一步,可能要反复调泰康 DOM)
4. **Week 4**: M4 + M5(screenpipe 集成,先单独验证再集成)
5. **Week 5**: M6(Android 端,可与 M4 并行)
6. **Week 6**: M7(LLM 接入)+ 端到端剧本演示

### 7.2 每个里程碑开始前的检查清单

- [ ] 看了对应章节的"实现思路"和"已知风险"
- [ ] 验证了前置条件
- [ ] 明确了验收标准(怎么算这一步通过了)
- [ ] **MVP 原则**:能用就行,可读 > 优雅,小步快跑

### 7.3 关键资料链接

- screenpipe GitHub: https://github.com/screenpipe/screenpipe
- screenpipe REST API 文档: https://docs.screenpi.pe/cli-reference
- Chrome Extension Manifest V3: https://developer.chrome.com/docs/extensions/develop/migrate
- 阿里云 DashScope: https://help.aliyun.com/zh/dashscope/
- 阿里云语音交互录音文件识别: https://help.aliyun.com/zh/isi/file-transcription/
- 阿里云 OSS Node SDK + STS: https://help.aliyun.com/zh/oss/developer-reference/

### 7.4 调试技巧

- **浏览器插件调试**:在 `chrome://extensions` 开启开发者模式,点扩展卡片的"service worker"链接打开后台脚本控制台;打开泰康页面后按 F12,Console 里能看 content script 日志
- **screenpipe 调试**:开发期间手动启动 screenpipe,用浏览器访问 `http://localhost:3030/search?content_type=all&limit=10` 看返回 JSON,确认数据格式后再写集成代码
- **Electron 调试**:渲染进程用 Chrome DevTools(`Ctrl+Shift+I`);主进程用 `--inspect=9229` 启动后 Chrome 访问 `chrome://inspect`
- **Android 调试**:`adb logcat -s 寰宇` 过滤日志;录音目录探测用 `adb shell ls /storage/emulated/0/Sounds/CallRecord/`
- **后端调试**:用 Postman 或 HTTPie 直接打 API,先确保后端能独立工作,再让客户端接

### 7.5 风险登记(开发期间不断更新)

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 企微 4.x AT 拿不到文本 | M4 失败 | 提前 Day 1 验证;失败则用 OCR 路线 |
| 泰康有反爬虫风控 | M1/M3 失败 | 不高频扫描;只在用户操作时触发 |
| 鸿蒙系统级权限拒绝 | M6 失败 | 提前在测试机演练完整权限申请流程 |
| OSS 上传带宽问题 | M4/M6 慢 | OSS 同地域(华东1),开启 BGP 加速 |
| DashScope 限流 | M7 失败 | 申请正式 APIKey 提额度 |

---

## 八、MVP 演示脚本(给业务方看的)

MVP 完成后,演示按下面这个剧本走,业务方一眼能看懂:

1. 打开 Chrome,登录泰康,切到申领页 → "你看,我什么都没干"
2. 打开寰宇采集客户端 → "工作台里已经看到这页的所有订单了"
3. 点其中一条订单的"申领" → 切回浏览器看泰康自动点了申领 → "我没碰鼠标,程序自己点的"
4. 切回工作台 → "订单已经在'我的'里了"
5. 拿手机打这单的客户电话,聊两句挂断 → "什么都不用做"
6. 用企微给客户发"您好您的挂号已完成" → "什么都不用做"
7. 回工作台,点这条订单 → "通话、录音、文字、微信对话、AI 摘要,全都在这"

**关键话术:全程员工只做了三件事:点申领、打电话、发微信。其他全是程序自己做的。这就是"无感采集 + 无感回填"的可行性证明。**

---

## 附录 A:开发环境约定

- Node.js 20 LTS
- Python 3.11(如果后端用 FastAPI)
- Android Studio Hedgehog+,SDK 34
- JDK 17
- Chrome 120+
- 测试机:Windows 11 + Chrome 最新 + 企微 4.1.x + 个人微信 4.0.x
- 测试手机:华为 HarmonyOS 4.x(具体型号开发时确认)

## 附录 B:数据流总览(便于理解)

```
泰康页面 ──[content script]──→ 浏览器插件 ──HTTPS──→ 阿里云后端 ←──HTTPS── Tray App 工作台
                                                       │
企微/微信 ──[screenpipe]──→ Tray App ──HTTPS──→     [MySQL]
                                                       │
                                                       │
通话/录音 ──[Android App]──→ ─────HTTPS──→           [OSS]
                                                       │
                                                       ▼
                                                  DashScope LLM
                                                  阿里云 ASR
```
