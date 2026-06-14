# 智能寰宇 tray-app 工作交接文档（给接手的 AI）

> 本文档面向**接手本项目的下一个 AI**，目标是让它无需翻聊天记录就能继续 tray-app（及配套的采集 sidecar、后端、Chrome 插件）的所有工作。
> 阅读顺序建议：先读「一、业务背景」+「二、铁律」+「三、环境与命令」，再按当前任务跳到对应章节。
> 写作时间：2026-06-12。

---

## 一、业务背景（必读）

**寰宇医道**为保险客户提供**医疗绿色通道服务**：客户买了保险公司（**泰康**、平安等）的健康权益后，由寰宇的**服务专员**落地服务——主要是**挂号协助**和**绿通业务**（陪诊、住院协调、检查加急、专家会诊等）。

专员日常：订单从保险公司系统流入 → 专员**申领** → 通过**微信/企业微信/电话**与客户沟通 → 协调医疗资源 → 完成服务 → 把关键信息**回填**到泰康/平安系统及寰宇自己的订单系统。

**本项目要解决的核心问题**：专员的沟通过程（电话、微信、图片）散落无沉淀；从沟通里整理"要回填的关键信息"全靠人工。我们要做**无感数据采集 + 工作台 + （未来）AI 关键信息提取**。

**当前阶段定位**：
- 近期（已进行）：去寰宇**现场采集真实数据**，用「采集版 tray-app」(v1) + Chrome 插件 + 移动端。
- 进行中：重做「最终功能版 tray-app」(v2) 的 UI/功能。
- 最近重点：**微信 PC 端的无感截图采集**（capture-sidecar），现场确认只采 PC 端微信/企微即可（手机消息大多会同步到 PC）。

相关业务文档（都在 `docs/`）：
- `寰宇医道业务现状调研分析报告_完善版.md`、`寰宇医道_员工日常工作流.md` — 业务全貌
- `寰宇医道_最终功能版_功能设计.md` — **v2 的功能设计（交给 UI 设计师的版本）**
- `寰宇医道_管理后台设计.md` — 管理后台（另一个 AI 开发，跑在阿里云 ECS）
- `寰宇医道_MVP_*.md` — 早期 MVP 技术设计（含订单抽象状态机、多员工协作、OCR 采集等）

---

## 二、铁律（违反会出大问题）

1. **所有 LLM/VLM 调用必须走后端**。tray-app / sidecar **绝不能持有任何 API key**——因为代码会 deploy 到员工的 Windows VM，`.env` 不上 VM，key 一旦随源码下发就泄露。
   - 现状：`capture-ai-reconstruct.ts`、`capture-layout-service.ts` 已**废弃**，构造函数直接抛错，指向"应在 backend 实现 `/api/v1/admin/vlm-reconstruct`、`/api/v1/admin/vlm-layout`"。要恢复 AI 能力就走这条路。
2. **改完 tray-app / extension / shared-types / capture-sidecar 后，要让用户在 VM 上验证 → 必须 `pnpm deploy:win`**。VM 与 Mac **不共享目录**，不部署 VM 上就是旧代码。后端（`packages/backend`）跑在 Mac 上、VM 走网络访问，**后端改动不用部署**。
3. **协作协议**（见 `/Users/xipilabs/dev/CLAUDE.md`）：讲故事→功能→UI→技术选型→详细设计→To-Do→小步编码。**变更前先确认是否更新设计，再改代码**。不要一次写完所有代码。
4. **不要凭空捏造字段**。泰康订单字段以 Chrome 插件实际发来的为准（见后端 `orders` 接口推导逻辑），不确定就查数据库/接口。

---

## 三、环境、凭证与命令

### 机器与网络
> ⚠️ **部署目标在变化**：早期在「Apple Silicon Mac 上的 ARM64 Parallels VM」跑/测；**tray-app 现已切到公司内网的 x64 荣耀笔记本**（见 `scripts/deploy-win.js` 顶部注释 + `v2/api.ts` 的后端地址）。sidecar 早期独立测试在 ARM64 VM 上。**给员工出包必须按目标机架构（现在是 x64）**。
- **Windows 部署机**（SSH 凭证在根 `.env`：`WIN_VM_HOST / WIN_VM_PORT / WIN_VM_USERNAME / WIN_VM_PASSWORD / WIN_VM_TARGET_DIR`）：
  - IP 会变，连不上就扫网段（示例 ARM VM 网段，按实际改）：
    ```bash
    for i in $(seq 100 160); do (nc -z -G1 192.168.202.$i 22 2>/dev/null && echo "192.168.202.$i:22 OPEN") & done; wait
    ```
    扫到后改 `.env` 的 `WIN_VM_HOST`。
  - 机器上**没有 MSVC 编译器**，但有 .NET 8 SDK + Node/pnpm。原生模块靠**下载预编译包**。
- **后端地址**（后端跑在 Mac、监听 `0.0.0.0`）：Mac 本机 `http://localhost:13000`；内网其它机器（部署机/手机）走 **Mac 的内网 IP** —— `v2/api.ts` 里**写死**为当前 Mac IP（最近是 `192.168.99.165`）。**Mac 是 DHCP，IP 一变就要同步改 `v2/api.ts` 和员工机配置**；建议给 Mac 绑固定内网 IP。
- **员工工号**：现场真实数据在 **`w001`**（DB employee id=4，约 300 单）。登录鉴权只认 `X-Employee-Code` 头，无密码体系。
- **LLM**：直连**阿里云百炼(DashScope)** OpenAI 兼容端点(`dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`)，凭证 `DASHSCOPE_API_KEY`(env，与 ASR 复用)。客户端 `src/llm/gatewayClient.ts` 的 `chat()`。**仅后端调用**(铁律)。
  - 模型：环境变量 `HYYD_LLM_MODEL` 指定，当前用旗舰 **`qwen3.7-max-2026-06-08`**(已在 backend/.env 配置、验证可用)。代码默认 `qwen-plus`(兜底)。换模型只改这行 env，不动代码。
  - ⚠️ 模型需在**百炼控制台「模型广场」开通**对应权限，否则报 403 access_denied(qwen-max 系列曾因此报错)。当前 key 已开通 qwen-plus 与 qwen3.7-max。
  - 历史：之前走自建 blackwhite 网关(`GATEWAY_*`)，2026-06-13 改百炼直连。`gatewayClient.ts` 里 `chatStream/submitJob` 是历史死代码、未使用。
- **管理后台密码**：`hyyd-admin-2026`（在 `packages/backend/.env`）。

### 常用命令（根目录）
```bash
pnpm backend:dev          # 起后端（Mac 本机）
pnpm tray:dev             # 起 tray-app v1（Electron，开发）
pnpm --filter tray-app dev:v2   # 起 v2 浏览器预览（纯网页，vite，端口 5180）
pnpm deploy:win           # 全量部署到 VM（上传源码→VM 端 install/build→重启 tray app + 重建 sidecar）
pnpm package:win          # 在 VM 上打 NSIS 安装包（给员工）
pnpm sidecar:build:win    # 在“当前机器”上 dotnet publish sidecar（一般由 deploy 在 VM 上触发）
node scripts/build-sidecar-only-win.js   # ★只传 sidecar 源码 + 在 VM 编 arm64 单文件（独立测微信采集用，不动 tray-app）
node scripts/diag-native-win.js          # 诊断 VM 上 better-sqlite3 / electron 的 PE 架构
node scripts/fix-native-win.js           # 把 VM 上 better-sqlite3 重建为 arm64
```

---

## 四、仓库总览（pnpm monorepo）

| 包 | 技术栈 | 作用 |
|---|---|---|
| `packages/backend` | Fastify + Prisma + PostgreSQL + MinIO | 订单/素材/通话(ASR)/消息/管理后台/在线状态 接口 |
| `packages/tray-app` | Electron + React 18 + TS + Tailwind v4 | 专员桌面端（**v1 采集版** + **v2 最终版**两套并存） |
| `packages/extension` | Chrome MV3 (tsup) | content script 扫泰康 CCM 个人池、上报订单、执行申领/抓详情 |
| `packages/capture-sidecar` | C# .NET 8 (`net8.0-windows`) | **微信/企微 PC 端无感截图采集**（仅 Windows 编译） |
| `packages/shared-types` | TS | 被 tray/extension 共用的类型 |
| `packages/admin-web` | React | 管理后台前端（另线开发） |
| `packages/android-app` | Android | 移动端采集 app |

---

## 五、tray-app —— 两个版本并存

### 5.1 v1「采集版」（现场在用，**不要删**）
- 入口：`src/main`（Electron 主进程）+ `src/renderer/src`（v1 渲染层，`pages/` 下 `MyWorkbenchView / OrderDetailModal / MaterialPanel / CallsView / MessagesView / SettingsView` 等）。
- 本地存储：`better-sqlite3`（`src/main/material-store.ts` 素材本地库 + `material-sync.ts` 后台同步 worker）。
- 核心功能：员工把微信消息/图片**粘贴**进来、**手工录入**电话要点；订单列表（挂号/绿通双 tab，表格化）；通话记录（ASR，按手机号关联订单，**本轮不做 LLM 分析**）。
- 采集 sidecar 默认**关闭**：`HYYD_ENABLE_SIDECAR=1` 才启动（`src/main/index.ts`）。
- 状态：功能稳定、已打安装包在 VM 测过。这是现场采集用的版本。

### 5.2 v2「最终功能版」（**在建，重点**）
- **独立入口、与 v1 完全隔离**：
  - HTML：`src/renderer/index-v2.html`，入口 `src/v2/main.tsx`，样式 `src/v2/styles.css`（Tailwind v4 `@theme` 设计令牌）。
  - 开发预览：`pnpm --filter tray-app dev:v2`（`vite.v2.config.ts`，**纯浏览器**，localhost:5180，不走 Electron）。
  - **尚未接入 Electron 主进程**——目前只在浏览器里开发预览。
  - 后端访问层 `src/v2/api.ts`：**纯 HTTP、不依赖 IPC**，后端地址**写死** `http://192.168.202.1:13000`（VM 内和 Mac 浏览器都可达）。登录态存 localStorage（键名 `hyyd.v2.*`，与 v1 隔开）。
- **已完成页面**（`src/v2/`）：
  - `pages/LoginPage.tsx` — 登录（工号，密码暂未启用）。**App 名「智能寰宇」，登录页避开"绿通"二字**。
  - `components/AppShell.tsx` — 顶部一级导航（待申领/工作台/客户档案/知识库/数据看板）。
  - `pages/WorkbenchKanban.tsx` — **工作台**：看板/列表双视图切换。
    - 看板：4 泳道（待处理/进行中/待确认回填/已完成），`flex-1` 自适应铺满。卡片彩色（按业务类型配色 + 左色条）、紧凑、右上角来源带色图标、右下角日期、可复制手机号/订单号、点卡片进详情。
    - 列表：密集可排序表格 + 状态筛选条（海量订单扫读用）。
  - `pages/OrderDetailPage.tsx` — **订单详情**（聚焦全屏视图）：顶部信息 chip + **服务生命周期阶段轴**（`已申领→需求沟通→资源协调→服务交付→信息确认回填→完成`）+ 右侧标签页「数据补录（粘贴+手工录入，非表单）/ AI 关键信息（待接入占位）」。
  - `lib/orderMapping.ts` — 订单状态→泳道映射、业务类型/来源调色板、生命周期阶段、相对时间/日期等。**映射规则集中在此，可随业务调整**。
- **数据**：真实拉后端 `/api/v1/orders`、`/api/v1/materials`。`WorkbenchKanban.tsx` 里有 `MOCK_DONE`（两张模拟"已完成"卡，仅为预览，真实完成态数据接入后删）。
- **UI 设计来源**：`docs/stitch_ui_interface_design/`（设计师产出的静态 HTML 原型，`_2`=看板、`ai`=订单详情、`login`、`360`=客户档案、`_4`/`_6`=数据看板、`_3`/`_5`=知识库）。**注意：原型上的列表字段/数据是占位的，要按真实数据和业务接**。
- **设计踩坑**：Material Symbols 图标默认被 Google 字体 CSS 的 `font-size:24px` 覆盖，Tailwind `text-[Npx]` 压不住 → **用行内 `style={{fontSize}}`** 控制图标大小。

> v2 的功能范围、各页定义见 `docs/寰宇医道_最终功能版_功能设计.md`（含数据看板＝公司级运营驾驶舱的详细区块）。

---

## 六、capture-sidecar —— 微信/企微 PC 端无感采集（最近重点）

### 6.1 定位
独立的 C# 控制台 exe（`hyyd-capture-sidecar.exe`），stdin 收命令、stdout 吐 JSON（`ready/status/frame/error`）、截图存本地。正常由 tray-app 主进程拉起并读 stdout 上传；**也能脱离 tray-app 独立运行测试**。只编译/运行于 Windows。

### 6.2 处理管线（当前）
```
事件/定时触发 → 截当前前台窗口(仅微信/企微) → 去重 → OCR → 客户会话过滤 → 落盘+上报
```

### 6.3 智能截图触发（已实现）
- 文件：`InputEventMonitor.cs`（独立线程跑 Win32 消息循环，装钩子）+ `NativeMethods.cs`（P/Invoke）。
- 触发源：
  - **前台变更** `EVENT_SYSTEM_FOREGROUND`（微信被激活）→ reason `foreground`
  - **回车** `WH_KEYBOARD_LL`（发消息）→ `key-enter`
  - **滚轮** `WH_MOUSE_LL`（翻历史）→ `wheel`
  - **鼠标左键松开** `WM_LBUTTONUP`（点击/拖滚动条结束）→ `click`（**只在松开触发，不在按下**——避免截到动作前的旧画面、也避免与松开重复；拖滚动条能截到滚完的结果）
  - **兜底定时** 5s（`HYYD_CAPTURE_INTERVAL_SECONDS` 可覆盖）→ `interval`。**定时不能删也不宜缩短**：客户发消息、员工没动键鼠时，只有定时能截到。
- 节流：`CaptureCollector.cs` 里 **尾沿防抖 600ms**（连续打字/滚动只在停顿后截一张）+ **最小间隔 1s**。
- 钩子回调只做"置信号"（极轻），实际是否截由采集循环统一判定。

### 6.4 去重（`FrameDeduplicator.cs`，之前就调得很好）
- 每渠道维护**最近 30 张已保留帧**的指纹，当前帧与这 30 张逐一比，**与任一张差异 < 0.005 即跳过**（所以"切走又切回、画面没变"也能识别）。静止超 300s 用 heartbeat 兜底保留一张。
- **跳过的帧从不写盘**（内存里判完即丢，不是先存再删）。
- 阈值全部可用环境变量覆盖（`HYYD_CAPTURE_DIFF_THRESHOLD` 等）。
- 判定原因：`first_frame / visual_changed / near_duplicate / size_changed / heartbeat`。

### 6.5 客户会话过滤（**当前状态：临时方案，待改**）
- 现状：OCR 全文命中关键词（默认 **`就医服务群`**，`HYYD_CAPTURE_TITLE_KEYWORDS` 可覆盖）才保留，否则**删盘不上报**。OCR 失败时不过滤（保留，避免漏采）。
- **⚠️ 用户已明确：只按"就医服务群"过滤意义不大，最终要能"关联到订单"。**
- **已讨论确定的目标设计（下一步要做的）**：
  ```
  去重保留 → 全图 OCR → 用"锚点关键词 + 位置 + 最长行"在 OCR 结果里定位标题
     → 从标题解析关联键（订单号/姓名/手机号）
     → 命中：保留 + 记标题/键（可关联订单）
     → 未命中：按兜底规则（手机号等）决定留或丢
  ```
  选这条（"先全图 OCR 再从结果里定位标题"）而非"先定位标题区域再抠"，原因：全图 OCR 反正要做、定位更稳、有兜底、关联是独立一步。
- **历史教训**：之前用 VLM(`capture-layout-service.ts` 百炼) 框 title 区域再抠 OCR——现在没 key、且要跨微信版本鲁棒，**不走 VLM**，改用纯 OCR 锚点定位。
- **可复用的旧逻辑**在 `tray-app/src/main/capture-store.ts`：`isLikelyGroupTitle`（`/群|服务|沟通/`）、`classifyThread`、`extractPhone`、`extractRegionText`（按 bbox 在区域内抠文本、合并同行）。
- **【2026-06-12 已确认】`fwyy+数字` = 泰康 VIP 客户（寰宇称"高客"）的订单号**。即高客订单号以 `fwyy` 开头，群名 `…就医服务群fwyy1514012829958197248` 末尾那串就是订单号，**可作为关联订单的硬 key**（至少对高客）。
  - ⚠️ **两档订单号**：高客=`fwyy…`；**普客=我们库里现有的 `COD…/CCOD…/OD…`**（CCM 个人池数据，w001 那 ~300 单都是普客）。即高客的 fwyy 是另一套、后端目前没有，要用它关联得补字段/映射（待办）；普客用库里的号本就能关联。**待确认**：普客的群名/备注名里到底放 `COD/CCOD/OD` 哪个前缀。
- **标题识别方案（梳理后，分两类，见下方专节「标题识别方案」）**。

### 6.6 独立自测模式（调试用）
- 运行：`hyyd-capture-sidecar.exe --standalone`（或环境变量 `HYYD_CAPTURE_STANDALONE=1`）。
- 行为：自动开始采集、保持运行到 Ctrl+C；**stdout 静音**（避免 OCR 逐字 bbox 刷屏），只在 **stderr** 打可读事件（`Diag.cs`，`Diag.Verbose=true`）：
  - `命中目标窗口 [wxwork] "…"`、`保留关键帧 [visual_changed] diff=… 触发=… → 路径`、`跳过·近似重复 diff=…`、`非客户会话，丢弃…`、`⚠️ …接近全黑…需改用 PrintWindow`、退出统计 `保留 X | 去重跳过 Y | 非客户会话过滤 Z`。
- 截图目录：`%LOCALAPPDATA%\HyydCaptureSidecar\frames\<日期>\`。
- 编译+测试流程：改完 `.cs` → `node scripts/build-sidecar-only-win.js`（会**先 taskkill 正在跑的 sidecar**，再按**构建机架构**自包含单文件 publish，arm64/x64 自动判断）→ 在目标机 PowerShell 跑 `--standalone` → 贴 stderr 日志核对。
- **黑屏自检**：`IsLikelyBlank` 网格采样，若接近全黑会告警——企微实测 BitBlt 抠图**正常、无需 PrintWindow**；若将来换微信版本截出黑屏，再上 `PrintWindow(PW_RENDERFULLCONTENT)`/DXGI。

### 6.7 标题识别方案（梳理后，**这是下一步要实现的核心**）

目标：从 keep+OCR 后的截图里，判断"是不是与客户的会话"，并尽量抽出**能关联订单的 key**。
**关键认知：泰康客户分两档——高客（VIP）订单号 `fwyy…`、普客（普通，我们库里现有的就是普客）订单号 `COD…/CCOD…/OD…`。群名结构两档一样，只有末尾订单号格式不同。** 共三类：

**类型 A — 高客群聊（企业微信"就医服务群"）**
- 群名结构（实例）：`20260610辽宁铂金李德恒先生就医服务群fwyy1514012829958197248`
  = `<日期><地区><客户等级铂金/金卡…><客户姓名+称谓>就医服务群<fwyy订单号>`
- 订单号 = `fwyy\d+`（latin+数字，OCR 稳）。

**类型 C — 普客群聊**
- 群名结构同 A，只是末尾订单号是**数据库里那种** `COD…/CCOD…/OD…`（hex 串），不是 fwyy。
- ⚠️ 待用真实普客群名核对：群名里到底用 `COD`(subOrderNo) / `CCOD`(applyNo) / `OD`(crmApplyNo) 哪个前缀。

**A/C 群聊统一识别**：OCR 命中 **`就医服务群`** 即判定为客户群（两档通吃）。再抽订单号：先试 `fwyy\d+`，否则试 `(CCOD|COD|OD)[0-9a-f]{12,}`。抽不到也保留（是就医服务群），订单号留空待后续按手机号等关联。姓名不从 OCR 抠——拿订单号去库取真实姓名更准。

**类型 B — 单聊（微信/企微 1 对 1 客户，高客或普客）**
- 现状命名不规范（如把对方加成"陈江波家属"）。需让寰宇**统一备注名为「客户姓名+订单号」**（中间可不加分隔符；建议留个空格更稳）。
- **识别**：聊天标题（备注名）里匹配到订单号 `fwyy\d+` 或 `(CCOD|COD|OD)[0-9a-f]{12,}`。
- **关键**：靠订单号识别+关联，**不靠姓名**——绕开"家属代沟通、姓名对不上本人"的坑。家属代沟通时姓名写客户本人、订单号不变即可。

**读标题的位置**（A6 的"锚点+位置"）：聊天标题在窗口**顶部横条**（群聊还带成员数）。
- v1 先简单做：OCR**全文** contains `就医服务群` / `fwyy\d+`（够测）。
  - 已知假阳性：左侧会话列表也会显示群名/备注名 → 列表界面可能误命中。
- v2 收敛：只取**顶部条**（按 bbox：y 在窗口顶部 ~10%、x 在侧栏右侧）里的文本当标题，减少误判。

**关联订单（本轮先不做，记 key 待后续）**：
- 抽到 `fwyy` 订单号后要关联，需要**后端订单侧有 fwyy 这个号**。当前后端只有 `COD/OD`（CCM 个人池），**没有 fwyy** → 待办：让 Chrome 插件/后端补抓 fwyy（看 CCM 详情页有没有），或暂时**按手机号关联**（和通话记录一样）。
- 本轮 sidecar 只做：**识别是客户会话 → 保留 + 把抽到的 orderNo/keyword 作为元数据带上**，关联留给后端/以后。

**给寰宇的单聊命名建议（待用户拍板后提给寰宇）**：
- 格式 `客户姓名-订单号`（订单号**原样**，高客即 `fwyy…` 完整串）。
- 理由：① 必须含订单号 → 我们靠它关联+过滤，不靠姓名；② fwyy+数字 OCR 比中文名稳；③ 加分隔符便于人读+机器切分；④ 家属代沟通时姓名写**客户本人**、可加"(家属)"，订单号不变 → 仍正确归属本人订单。
- **需向寰宇确认**：普通（非高客）客户的订单号格式？他们单聊/群名是否带号？若不带 fwyy，匹配正则要扩展。
- 不建议截断订单号（容易撞号），宁可长。

### 6.8 消息结构化（路线1，已实现第一版）`MessageStructurer.cs`
把一张聊天截图的 OCR + 像素，结构化成**带说话人的消息列表**（给后端 LLM 抽关键信息用）。**说话人不靠 AI 猜，靠确定性规则**：
- **气泡底色采样**：高饱和(绿/蓝)= `self`（本员工）；灰/白 = `other`（客户/群成员）。**自己永远是"有色"那个**，所以深/浅色模式、微信(绿)/企微(蓝)通用。取不到色用左右位置兜底（右=self、左=other）。
- 词→行→气泡聚类（按垂直间隔 + 左右切换分条）；居中 + 时间/日期/撤回文案 → `system`。
- 裁掉顶部标题栏、底部输入框（比例 env 可调：`HYYD_CHAT_TOP_FRAC`/`HYYD_CHAT_BOTTOM_FRAC`/`HYYD_CHAT_LEFT_FRAC`；饱和度阈值 `HYYD_BUBBLE_SAT`）。
- 结果进 `FramePayload.messages`（`StructuredMessage{speaker,name,text}`），独立模式日志也会打印。
- **第一版已知缺口（下一步）**：群里对方**具体昵称**(`name` 暂为空，只分 self/other)；纯图片/语音消息（OCR 无文字会漏）；侧栏裁切比例需用真实全窗口截图调。
- **离线测试模式**：`hyyd-capture-sidecar.exe --test-image <png路径>` → 对该图跑 OCR+结构化并打印（不开窗口、可重复，调参用）。

### 6.9 路线1 的定位（重要）
最终目标是 AI 抽"可回填关键信息"（再往后才是知识库）。**不追求完美还原整条聊天**，只要不漏关键信息。流程：sidecar 结构化出"带说话人消息" → 后端 LLM 抽关键字段。说话人用确定性规则定（解决"AI 老说错说话人"），LLM 只做抽取（它最擅长的）。跨多张截图**不强行拼接**，靠内容去重 + 一起喂给 LLM 容错。**VLM/LLM 调用必须走后端**（铁律1）。

### 6.10 结构化方案演进（⚠️ 讨论中、未定稿，2026-06-13）
**现状（已实现，但偏 ad-hoc，要替换）**：`MessageStructurer` 用「固定比例裁剪（按渠道）+ 关键词锚点（企微"成员/看板"定位右侧成员面板）」分区。问题：比例对窗口缩放/拖动分隔线不鲁棒；锚点太针对性。

**已讨论确定的方向（待真实 OCR 数据验证后再落地，先别照现状扩展）**：
1. **地基：OCR 块统一"拼成行"**。Windows OCR 把中文**逐字拆成单独词块**，所以任何 `Contains("群成员")` 在词块级都匹配不到；必须先按坐标把同一行的字拼成行，再在**行文本**上做所有匹配（关键词/订单号/消息）。
   - 拼行规则：按 Y 排序，垂直中心差 ≤0.6×字高算同一行；行内按 X 升序拼接（保证字序正确）。
   - ⚠️ 现有拼行**只看 Y、不看 X 分列** → 同一 Y 上跨栏的字会被并进一行。要补「X 相邻才合并、X 大间隔则断列」。
2. **区域分离：用 OCR 坐标做"列检测"，替代固定比例 + 关键词锚点**。把所有文字块 X 投影到横轴，栏与栏之间是**竖直空白条**（无文字）；找出空白条 → 切出各列 → **中间最宽的密集列 = 聊天区**。通用、抗窗口缩放/面板开合/不依赖关键词。微信（左栏+聊天）、企微群（左栏+聊天+右成员栏）都能自动切出聊天列。
3. **已否决「只保留气泡」**：群里**发送者昵称**（气泡上方、左对齐、无气泡）和**时间分隔**（居中，今天=时:分、早的=日期+时分）都是要保留的内容，但不在气泡里 → 只留气泡会丢掉它们。
4. **聊天列内部**再做：行分组 → 说话人（气泡背景饱和度：有色=self/灰白=other）+ 昵称（气泡上方左对齐）+ 时间（居中/日期格式）。
- **状态：列检测已用真实 OCR 坐标验证可行（2026-06-13）**。`--test-image` 会导出 `__BLOCKS__` 块坐标 JSON（`scripts/ssh-test-image.js` + node 分析）。实测：
  - 企微 1343×812：空白竖条 365-407、1109-1156（33-48px，很明显）→ 切出 图标栏/会话列表(268w)/**聊天(701w 最宽)**/成员面板(127w)。
  - 微信 1118×788：→ 图标栏/会话列表(268w)/**聊天(575w 最宽)**/边缘噪点。
  - 规则：X 投影找 ≥~20px 空白竖条切列 → **取最宽的密集列(块数≥5)= 聊天区**。两端、窗口尺寸、成员面板开关都成立，**替代全部比例+锚点 hack**。
- **已实现（2026-06-13）**：`MessageStructurer` 改为 `DetectChatXRange`（X 投影找空白竖条→取最宽密集列=聊天区，纯动态），替换了所有固定比例 + 成员锚点。两端实测：微信侧栏排除/客户长消息完整/self·other·system 全对；企微群成员面板+侧栏排除/self·other 正确。
  - 注：曾试「拼行加 X 间隔断行」，会切碎正常多行消息（且乱序），**已撤销**——列检测隔离聊天列后，拼行只按 Y 即可。
  - **残留小噪声（可后续再优化，对 LLM 抽取无碍）**：群里发送者昵称行（如"常远征"）仍标 [other]；改群名等系统提示因行太长没被判 system；个别顶部按钮（"快速会议"）偶尔落进聊天列。
  - **未做**：群昵称归属（把昵称挂到对应 other 消息的 name 上）——下一步增强。

---

## 七、后端接口要点（`packages/backend/src/routes/api.ts`）

### 7.0 订单号模糊解析 + 待确认（2026-06-12 已实现，本地验证通过）
- `src/lib/orderNoMatch.ts`：从标题抽订单号候选 → **OCR 易混字符归一(O→0/l→1/s→5…) + 编辑距离≤2 + 截到订单号长度比对(消尾部粘连) → 取唯一最近**。普客 OCR 错 1-2 位也能自动关联。
- 接进 `POST /api/v1/messages`：有订单号→模糊解析关联；解析不到/多单并列→写 `unmatched_order_refs` 表（待客户/员工确认）；没订单号→退回按姓名匹配。
- 给 UI（另一端开发）的接口：`GET /api/v1/unmatched-order-refs?status=pending`、`POST …/:id/confirm{orderId}`(确认并回填该会话历史消息到订单)、`POST …/:id/reject`。
- **详细交接见 [docs/订单号待确认_交接说明.md](订单号待确认_交接说明.md)**。
- 高客 fwyy 当前必进待确认（库里暂无 fwyy）→ 待办：补 fwyy→订单映射。

### 7.05 关键信息抽取（路线1 的 AI 环节，2026-06-13 已建好、未自动触发）
- **AI 的唯一职责 = 从"带说话人的对话"抽可回填关键信息**。不是 VLM、不做消息还原(说话人已由 sidecar 用 OCR+颜色确定性判好)、不做去重(程序按内容哈希去重)。
- 服务 `src/llm/keyInfoService.ts` `extractKeyInfo(messages, context?)` → 调百炼 `qwen-plus` → 返回结构化字段(意向医院/科室/医生/就诊时间/主诉/病情/特殊要求/沟通偏好/其它 + summary)，没有的填 null、不编造。
- 接口 `POST /api/v1/ai/extract-key-info`，body `{messages:[{speaker,name?,text}], orderContext?}`。**可独立调(冒烟测过，效果好)**，但**不自动触发**——先测 sidecar 结构化效果，OK 后再接进流程(攒够消息后端自动抽 / 员工点按钮)。

### 7.1 其它接口
- `GET /api/v1/me`（鉴权=校验工号存在）；`GET /api/v1/orders`（推导 customerPhone/hospital/dept/doctor/intendDate + 各类计数，从 `rawJson`/`detailJson.recommendations`）。
- 素材：`POST /api/v1/orders/:id/materials`（text/image，`clientUuid` 幂等，image 走 base64→MinIO）、`GET /api/v1/materials?orderId=`、`DELETE /api/v1/materials/:id`。
- 通话：ASR（Fun-ASR/DashScope），`GET/POST /api/v1/calls`，按**手机号**实时匹配订单（`relatedOrders`，可能 0/1/N）。
- 消息、`/api/v1/admin/*`（管理后台）、presence（在线状态）。
- 订单详情字段在 `detailJson.recommendations.*`（**不是 caseInfo**）。

---

## 八、已解决的坑（避免重踩）
1. **better-sqlite3 / Electron 架构必须和目标机一致**，否则报 `is not a valid Win32 application` / `Electron uninstall`。
   - **当前部署目标是 x64 荣耀笔记本** → `deploy-win.js` 的 `archInjection` 现为空（用 x64 原生默认即可）。
   - 历史：早期 ARM64 VM 上 `install-app-deps` 默认按 x64 编 better-sqlite3 → 塞进 arm64 Electron 报错。当时用 `install-app-deps --arch arm64`（`scripts/fix-native-win.js`）+ deploy 注入 `npm_config_arch=arm64` 修复。
   - **若以后又部署到 ARM64**：把 `deploy-win.js` 的 `archInjection` 改回 `npm_config_arch=arm64`，或改成按目标机 `PROCESSOR_ARCHITECTURE` 动态判断（注释里已写）。
   - 诊断/修复脚本：`scripts/diag-native-win.js`（看 PE 架构）、`scripts/fix-native-win.js`。
2. **Material Symbols 图标压不小**：Google 字体 CSS `font-size:24px` 覆盖 Tailwind `text-[]` → 用**行内 `style={{fontSize}}`**。
3. **sidecar 独立模式 stdout 刷屏**：OCR 逐字 bbox 太多 → `JsonLineWriter.Muted` 在 standalone 静音。
4. **构建 EPERM**：正在跑的 sidecar 锁住 exe → 构建脚本先 `taskkill`。
5. **VM IP 漂移** → 扫网段改 `.env`（见三）。
6. **MinIO public host 用了过期 IP** → 改 `MINIO_PUBLIC_HOST` 为当前宿主机 IP 并重启后端。
7. **clipboard 读取**：网页 `navigator.clipboard` 在 Electron 里读微信 DIB 图会失败 → v1 用 Electron 原生 `clipboard` IPC；v2 浏览器预览用 `navigator.clipboard.read()`（图片）/`readText()`。
8. **employeeCode 不设默认值**：两端都强制配置（曾因默认 `huanyu-field-1` 看不到 w001 的单）。

---

## 九、待办 & 开放决策（交接重点）
1. **【sidecar】客户会话过滤 → 订单关联**：按 §6.7「标题识别方案」实现——群聊认 `就医服务群`/`fwyy\d+`、单聊认备注名里的订单号。fwyy=高客订单号已确认；待办是**后端补 fwyy 字段**（或先按手机号关联）+ **确认普通客户号格式** + **提单聊命名规范给寰宇**。
2. **【tray-app v2】**：仍在重构（用户说还需相当时间）。后续要把 v2 **接入 Electron 主进程**（目前只浏览器预览），并逐页接入「待申领/客户档案/知识库」（数据看板建议并入管理后台）。
3. **【打包】给员工的安装包确认架构（x64?）**，并让 sidecar/better-sqlite3 按目标架构打。
4. **【AI 接入】**：tray-app 的「AI 关键信息」标签页、sidecar 的消息还原都是占位——要做必须在 **backend** 新建 VLM/LLM 端点（`/api/v1/admin/vlm-*`），tray-app/sidecar 通过后端转发（铁律 1）。
5. **【管理后台】**：`docs/寰宇医道_管理后台设计.md` 已写好，由另一个 AI 在 ECS 上开发；数据看板可复用其设计。

---

## 十、关键文件索引
- 采集触发/去重/过滤：`packages/capture-sidecar/{InputEventMonitor,CaptureCollector,FrameDeduplicator,WindowInspector,WindowCapture,WindowsOcr,NativeMethods,Diag,Program}.cs`
- v2 工作台/详情：`packages/tray-app/src/renderer/src/v2/`（`api.ts`、`lib/orderMapping.ts`、`pages/*`、`components/AppShell.tsx`）
- v1 采集：`packages/tray-app/src/main/`（`material-store.ts`、`material-sync.ts`、`capture-store.ts`、`index.ts`）
- 部署/构建脚本：`scripts/{deploy-win,build-installer-win,build-sidecar-win,build-sidecar-only-win,diag-native-win,fix-native-win}.js`
- 后端：`packages/backend/src/routes/api.ts`、`prisma/schema.prisma`
- 设计文档：`docs/寰宇医道_最终功能版_功能设计.md`、`docs/寰宇医道_管理后台设计.md`、`docs/寰宇医道_MVP_*.md`
- 协作协议 & 全局规则：`/Users/xipilabs/dev/CLAUDE.md`、`/Users/xipilabs/.claude/CLAUDE.md`

---

## 附录 A：capture-sidecar 实现细节（逐模块算法）

> 这一节是「怎么实现的」，配合第六章「是什么」一起看。每条都标了文件/方法。

### A1. 窗口识别 `WindowInspector.GetForegroundTarget()`
1. `GetForegroundWindow()` 取当前前台窗口；不可见(`!IsWindowVisible`)或最小化(`IsIconic`)→ 返回 null。
2. `GetWindowThreadProcessId` → 进程名，匹配目标表 `{WXWork.exe→wxwork, WeChat.exe→wechat, Weixin.exe→wechat}`（**新版微信进程名是 `Weixin.exe`**）。非目标进程 → null。
3. **排除非主窗口**：`GetWindow(GW_OWNER)!=0`（被 own 的菜单/对话框/浮层）或 `WS_EX_TOOLWINDOW`（工具窗）→ null。原因：这些同属微信进程，但带阴影/透明外扩边距，按它的 rect 抠图会把桌面也抠进来。
4. `GetWindowRect` 取矩形；宽<320 或 高<240 → 抛错（太小，多半是异常窗口）。
5. 返回 `TargetWindow(channel, processName, windowTitle, rect, "normal")`。
   - 注意：微信**主窗口标题**通常就是"微信/企业微信"，**不是会话名**；会话名/群名在窗口**内容区**（要靠 OCR）。

### A2. 抠图 `WindowCapture`
- `CaptureBitmap`：GDI **`Graphics.CopyFromScreen(rect.Left, rect.Top, 0,0, size, SourceCopy)`** 把**屏幕上该矩形区域**拷到内存 32bppARGB 位图，不落盘。
  - ⚠️ 含义是"截屏幕上这块区域"，所以**窗口必须在最前、未被遮挡**——这也是为什么前置了前台判定(A1)和稳定性判定(A3)。被别的窗口盖住会截到盖在上面的东西。
  - 企微实测 `CopyFromScreen` 抠图正常；若换微信版本截出黑屏（GPU/CEF），需改 `PrintWindow(PW_RENDERFULLCONTENT)` 或 DXGI 桌面复制。`CaptureCollector.IsLikelyBlank`（网格采样近全黑）会告警。
- `Persist`（仅保留帧调用）：PNG 编码 → SHA256 → 存 `%LOCALAPPDATA%\HyydCaptureSidecar\frames\yyyy-MM-dd\<yyyyMMdd-HHmmss-fff>-<channel>-<hash前12>.png`。

### A3. 稳定性 & 首帧延迟 `CaptureCollector.CaptureOnceIfTargetAsync`
- **窗口 key**（`进程名:标题:宽x高`）变化时：上报 status(true) + 等 **`FirstFrameDelay=700ms`**（让切窗/渲染稳定后再截）。
- **`GetStableTargetAsync`**：间隔 **150ms 读两次** rect，**完全相等**才算稳定才截；否则本轮跳过。防止截到正在拖动/缩放中的窗口（用旧坐标会截到窗口旧位置=此刻的桌面/别的窗口）。

### A4. 指纹与去重 `FrameSignature` + `FrameDeduplicator`
- **指纹 `FrameSignature.Build`**：把截图**按比例缩到固定宽**（默认 320px，`HYYD_CAPTURE_THUMBNAIL_WIDTH`）的**灰度缩略图**。灰度=定点亮度 `(r*77 + g*150 + b*29) >> 8`（≈0.299R+0.587G+0.114B），存 `byte[]`。
- **比较 `DiffAgainst`**：同尺寸下逐像素比，灰度差 `> perPixelThreshold`（默认 24）的算"变化像素"，返回 **变化像素数 / 总像素数**（0~1）；尺寸不同直接返回 1.0。
- **判定 `Decide`**：每渠道保留**最近 N=30 张已保留帧**的指纹；当前帧与这 30 张逐一算 diff 取最小值 `minDiff`：
  - 首帧 → `first_frame` 保留(0)
  - 窗口尺寸变了 → `size_changed` 保留(1.0)、清空该渠道历史
  - `minDiff < 0.005`（`HYYD_CAPTURE_DIFF_THRESHOLD`）→ `near_duplicate` **跳过**；但距上次保留 ≥ **heartbeat 300s** 则保留一张（`heartbeat`，证明窗口还开着）
  - 否则 → `visual_changed` 保留
- **要点**：比"最近 30 张"而非"仅上一张"，所以"切到别的会话又切回、画面没变"也能识别为重复。**跳过的帧从不写盘**（内存判完即丢）。

### A5. OCR `WindowsOcr`
- 引擎：`OcrEngine.TryCreateFromUserProfileLanguages()`（**Windows.Media.Ocr，系统自带、离线、无需任何 key**）。VM 需装对应语言包（中文）。
- `RecognizeAsync(path)`：StorageFile → BitmapDecoder → SoftwareBitmap(Bgra8) → 识别。
- 返回：**逐词(word)级 blocks**，每个含 `Text` + `bbox{x,y,w,h}`，外加整页 `Text`。**逐词带坐标**是后续"按位置定位标题"的基础。
- 时机：当前在"保留帧**落盘后**"OCR（因为 `RecognizeAsync` 只接受文件路径）。

### A6. 客户会话识别 `CaptureCollector.IsCustomerConversation`
- **当前实现（临时）**：`ocr.Text`（为空则拼接所有 `blocks.Text`）做全文 `Contains` 关键词（默认 `就医服务群`，`HYYD_CAPTURE_TITLE_KEYWORDS` 逗号分隔可覆盖，大小写不敏感）。命中→保留；不命中→**删盘不上报**(`_filteredCount++`)；OCR 失败(`status!=success`)→**不过滤**（保留，避免漏采）。
  - 局限：会话列表里若显示了"就医服务群"字样也会命中（假阳性）；单聊客户（无此字样）会被丢。当前仅供"先测着"。
- **目标实现（待做，已和用户讨论定方向）**：不要直接抠"标题区域"（脆、且需 VLM），而是
  1. 全图 OCR（反正要做）
  2. 用 **`blocks` 的 bbox** + "锚点词 + 靠顶部位置 + 最长行" 在 OCR 结果里**定位标题行**
  3. 从标题解析**关联键**（订单号/姓名/手机号）
  4. 命中→保留+记键(可关联订单)；未命中→兜底(全文找手机号等)决定留/丢
  - **可直接复用** `tray-app/src/main/capture-store.ts` 里的纯规则函数：`extractRegionText`（按 bbox 在矩形内抠文本、按行合并）、`isLikelyGroupTitle`（`/群|服务|沟通/`）、`extractPhone`（`1[3-9]\d{9}`）、`classifyThread`。
  - **关联 key 已明确**：群名/单聊里的 `fwyy\d+` = 泰康高客订单号（见 §6.5/6.7）。但我们后端订单侧暂无 fwyy 字段，需补抓/补映射，或先按手机号关联。详见 §6.7。

### A7. 触发→截图主循环 `CaptureCollector.RunAsync` / `WaitForCaptureAsync`
- 启动先截一张当前态。
- 循环：`WaitForCaptureAsync` → 最小间隔 1s 节流 → `CaptureOnceIfTargetAsync`。
- `WaitForCaptureAsync`：`_wake.WaitAsync(FallbackInterval=5s)`：
  - 超时返回 → 兜底定时截图（reason=interval）
  - 被信号唤醒 → **尾沿防抖**：循环 `WaitAsync(DebounceDelay=600ms)`，只要 600ms 内又来事件就继续等，直到输入停顿才去截（连续打字/滚动→只截最后一张）。
- `_wake` 是 `SemaphoreSlim(0,1)`，钩子线程 `OnInputTrigger(reason)` 里 `Release()`（满则忽略）+ 记 `_lastTriggerReason`。
- 窗口刚切入那帧的 reason 在 `CaptureOnceIfTargetAsync` 里**强制记为 `foreground`**，避免被"点图标激活"那一下的 click 覆盖（截图发生在 700ms 延迟之后，期间共享变量会被改）。

### A8. 全局钩子线程 `InputEventMonitor`
- 独立后台线程跑 **Win32 消息循环**（`GetMessage/Translate/Dispatch`）——低级钩子的回调依赖**本线程的消息泵**，没有消息循环钩子不触发。
- 装：`WH_KEYBOARD_LL`（回车）、`WH_MOUSE_LL`（滚轮 `WM_MOUSEWHEEL`、左键松开 `WM_LBUTTONUP`）、`SetWinEventHook(EVENT_SYSTEM_FOREGROUND)`（前台变更）。
- **必须持有委托引用**（`_kbProc/_mouseProc/_winEventProc` 字段），否则被 GC 回收 → 钩子回调崩。
- 回调只做"置信号"（极轻），是否真截由主循环统一判定（前台是不是微信 + 去重 + 过滤）。
- `Dispose`：`PostThreadMessage(threadId, WM_QUIT)` 让消息循环退出，再 `Unhook*`。

### A9. JSON 协议 & 命令 `Program` / `JsonLineWriter`
- stdin 收 `{"type":"ping|start|stop"}`；stdout 出 `ready/status/frame/error`（`JsonLineWriter`，camelCase）。
- `frame` 载荷 `FramePayload`：channel/processName/windowTitle/capturedAt/window{rect}/imagePath/sha256/**ocr(逐词 blocks)**/dedup reason/diffScore。tray-app 主进程读这个去上传。
- 独立自测：`--standalone` 或 `HYYD_CAPTURE_STANDALONE=1` → `writer.Muted=true`（stdout 静音，避免 OCR bbox 刷屏）+ `Diag.Verbose=true`（stderr 打可读事件）+ 自动 start、Ctrl+C 退出并打统计。
- 离线图片测试：`--test-image <png路径>` → 对该图跑 OCR + 结构化并打印（不开窗口、可重复，调参用）。开发机可用 `node scripts/ssh-test-image.js [图片路径]` 远程跑（不带参则自动挑 frames 目录里最新的一张）。

---

## 附录 B：采集数据如何集成进 tray-app（数据在哪 / 怎么给 UI / 全字段）

> 回答"集成时数据存哪、怎么给到 tray-app"。**v1 已有完整链路**，路线1 的新字段（结构化消息 / 订单号）**还没接进去**——见末尾「集成缺口」。

### B1. 数据流
```
sidecar.exe ──stdout JSON(每行一个 frame)──▶ CaptureSidecarClient(main 进程)
                                                  │
                          ┌───────────────────────┼───────────────────────┐
                          ▼                        ▼                       ▼
                  截图 PNG 落本地磁盘        元数据写本地 sqlite        (可选)上传后端
              %LOCALAPPDATA%\HyydCapture   userData/capture/capture.db   目前未接，见 B6
              Sidecar\frames\<日期>\*.png   (better-sqlite3)
                          │                        │
                          └──────────── Electron IPC ───────────▶ renderer(UI 展示)
```
- 启停 / spawn / 读 stdout：`packages/tray-app/src/main/capture-sidecar-client.ts`（`HYYD_ENABLE_SIDECAR=1` 才启）。
- 入库：`packages/tray-app/src/main/capture-store.ts`（CaptureStore）。
- frame 的 TS 类型：`packages/tray-app/src/main/capture-types.ts`（`CaptureFrameEvent`）。

### B2. 数据存哪
1. **截图 PNG（原图）**：磁盘 `%LOCALAPPDATA%\HyydCaptureSidecar\frames\<yyyy-MM-dd>\*.png`（sidecar 直接写）。文件名 = `日期-时分秒-毫秒-渠道-哈希前12.png`。
2. **元数据（sqlite）**：`app.getPath('userData')/capture/capture.db`（better-sqlite3）。三张主表：
   - **`capture_frames`**（每张关键帧一行）：channel, process_name, window_title, captured_at, window_*(left/top/width/height/show_state), screenshot_path, image_hash, phash, ocr_text_hash, chat_text_hash, ocr_engine, ocr_status, **ocr_text**, **ocr_blocks_json**(逐词+bbox), frame_status, created_at。
   - **`conversation_threads`**（会话/群，按 channel+thread_key 唯一）：conversation_title, normalized_title, phone, is_group, classification, first/last_seen_at, message_count …
   - **`message_blocks`**（每条消息一行，跨帧按 content_hash 去重）：thread_id, **sender_type**(self/other/system), **content**, bbox_*, first/last_seen_at, seen_count, content_hash, source_frame_ids, source_screenshot_path, sender_confidence …

### B3. sidecar → tray-app 的 frame 全字段（IPC 契约，**含路线1 新增**）
sidecar 每帧 stdout 的 `FramePayload`（camelCase）：
| 字段 | 说明 |
|---|---|
| `type` | 固定 `"frame"` |
| `channel` | `wechat` / `wxwork` |
| `processName` / `windowTitle` | 进程名 / 窗口标题（注意：主窗标题多为"微信"，**不是会话名**） |
| `capturedAt` | ISO 时间 |
| `window` | `{left,top,width,height,showState}` |
| `screenshotPath` | 本地 PNG 路径 |
| `imageHash` | 截图 SHA256 |
| `ocr` | `{engine,status,text,blocks[]}`，blocks 为**逐词 + bbox** |
| `keepReason` / `diffScore` | 去重判定原因 / 差异分 |
| **`conversationKind`** 🆕 | `group` / `single`（客户会话类型） |
| **`orderNo`** 🆕 | 标题里抽到的订单号候选（fwyy… / COD…），抽不到为 null |
| **`messages[]`** 🆕 | **路线1 结构化消息**：`{speaker:'self'|'other'|'system', name, text}` |

### B4. tray-app 给 renderer 的 IPC（已就绪，UI 直接调）
`preload/index.ts` 暴露（`window.api.*`）：
- `getCaptureStatus()` → `capture:status`（采集状态）
- `getCaptureConversations(channel?)` → `capture:conversations` → `conversation_threads` 列表
- `getCaptureMessages(threadId)` → `capture:messages` → 某会话的 `message_blocks`
- `getCaptureFrames(channel?, limit?)` → `capture:frames` → 原始帧（调试/兜底）
- `getCaptureScreenshot(path)` → `capture:screenshot` → 截图字节（展示大图）
- `getCaptureShots(channel?, limit?)` → `capture:shots` → **直接列磁盘 PNG**（不依赖 sqlite/OCR，最稳的兜底展示）
- `clearCaptureShots()` / `getCaptureLayout(id)` / `captureAiReconstruct(...)`(后两者关联已废弃的 VLM 布局/还原，勿用)

> 想给 UI "尽量全的数据"：会话列表用 `getCaptureConversations`，点进去用 `getCaptureMessages(threadId)` 拿带 sender_type 的消息，大图用 `getCaptureScreenshot`；想要最原始的兜底用 `getCaptureShots`（纯磁盘 PNG）。

### B5. ⚠️ 路线1 集成缺口（要做的就这 3 处）
sidecar 已经吐出 `messages[]/conversationKind/orderNo`，但 tray-app 还在用**旧的**入库逻辑（`capture-store.ts` 里的 `extractMessages(frame, layout)`，依赖已废弃的 VLM 布局），**没消费新字段**。集成时：
1. **`capture-types.ts`**：给 `CaptureFrameEvent` 补字段 `keepReason/diffScore/conversationKind/orderNo/messages`（类型对齐 sidecar）。
2. **`capture-store.ts`**：`persist` 改成**直接用 frame.messages 写 `message_blocks`**（sender_type=speaker，content=text，沿用 content_hash 去重），不再走 `extractMessages`；把 `orderNo/conversationKind` 存到 `conversation_threads`（可加列）。会话标题/订单号也可由此回填线程。
3. IPC 基本不用动（`listThreads/listMessageBlocks` 已能读）；如要展示 orderNo，给线程行加上即可。

### B6. 上传后端（当前未接；要做的话）
现在采集是**纯本地**（sqlite + 磁盘）。若要给管理后台看 / 跨设备，需把帧上传后端：
- 截图 PUT 到 MinIO（screenshots bucket）拿 ossKey；
- `POST /api/v1/messages`（已存在）带 `conversationName(=会话标题)/screenshotOssKey/contentText`，后端会**自动按 orderNo 模糊解析关联订单**（见 §7.0 + `docs/订单号待确认_交接说明.md`），解析不到进 `unmatched_order_refs` 待确认。
- 注意：后端 `Message` 是"每条消息一行"，路线1 一帧多条消息 → 每条 messages[] 映射一行，或新增"按帧存"的端点（按需设计）。

---

## 附录 C：sidecar → tray-app 集成实施指南（**给开发 tray-app 的 AI，照着做即可**）

> ⚠️ **架构已调整（2026-06-13）**：消息结构化（拼行/判说话人）**从 sidecar 移到后端**了，见
> [docs/变更说明_结构化移至后端.md](变更说明_结构化移至后端.md)。本附录下文"直接消费 sidecar 的
> `messages[]`"是**旧方案**——sidecar 仍会吐 `messages[]`（过渡期没删），但**正确方向**是：tray-app
> 把"OCR 词块(含 `colorSample`)+ 渠道 + 宽高"发 `POST /api/v1/capture/structure` 让**后端**结构化，
> 或在 `POST /api/v1/messages` 内部结构化后入库。**不要再在 tray-app 里写第二份结构化逻辑**（那正是
> 要删的重复）。下文步骤②里"直接用 frame.messages"按此调整。

> 这一节是**可直接落地的施工说明**。附录 A 讲 sidecar「怎么实现」、附录 B 讲「现状链路」；本节讲「**你要改哪些文件、改成什么样**」，把 sidecar 已经吐出的「带说话人结构化消息 + 订单号」真正接进 tray-app，并（可选）上传后端关联订单。
>
> **背景一句话**：sidecar 早已在每个 `frame` 里吐出 `messages[]`（self/other/system 已判好）、`conversationKind`、`orderNo`，但 tray-app 现在的入库逻辑（`capture-store.ts` 的 `extractMessages(frame, layout)`）是**旧的 VLM 布局方案残留**——`layout` 恒为 `null`，结果把整页 OCR 文本塞成**一条 `unknown` 消息**。也就是说：**新字段目前被白白丢弃**。本节就是把这条断点接上。

### C0. 铁律（再强调）
- **LLM/VLM 只在后端调**（百炼）。tray-app、sidecar **绝不**放 API key、绝不直连大模型。AI 抽取走后端 `POST /api/v1/ai/extract-key-info`。
- sidecar 已做的事（说话人判定、去重、客户会话过滤、订单号候选抽取）**不要在 tray-app 里重做**，直接用它的结果。

### C1. sidecar 帧的真实契约（以 C# 源码为准）
`packages/capture-sidecar/Models.cs` 的 `FramePayload`（stdout 每行一个，camelCase）：

```ts
interface CaptureFrameEvent {
  type: 'frame'
  channel: 'wechat' | 'wxwork'
  processName: string          // WXWork.exe / WeChat.exe / Weixin.exe
  windowTitle?: string | null  // 多为「微信」「企业微信」，不是会话名
  capturedAt: string           // ISO
  window: { left; top; width; height; showState }
  screenshotPath: string       // 本地 PNG 绝对路径
  imageHash?: string | null    // 截图 SHA256
  ocr: { engine; status: 'success'|'failed'; text; blocks: {text,bbox{x,y,width,height},confidence?}[] }
  keepReason: string           // 去重判定原因（first_frame/visual_changed/heartbeat…）
  diffScore: number            // 与最近 30 帧的最小差异分
  // —— 路线1 新增（当前 tray-app 类型里还没有）——
  conversationKind?: string | null   // 'group' | 'single'，非客户会话不会到这（已被 sidecar 过滤）
  orderNo?: string | null            // 标题/全文抽到的订单号候选(含 OCR 噪声)：fwyy… / COD/CCOD/OD…，无则 null
  messages: { speaker: 'self'|'other'|'system'; name?: string | null; text: string }[]
}
```

要点：
- `messages` 里 **speaker 已是确定性结果**（气泡颜色+位置判的，深浅色模式都成立），tray-app 直接信。
- `orderNo` 是**含噪候选**（OCR 可能错 1-2 位），**不要**自己在 tray-app 里精确比对——交给后端 `resolveOrder` 做归一+编辑距离（见 §7.0 / C4）。
- 残留噪声（群里发送者昵称单独成行、改群名系统提示偶尔被判 other、"快速会议"按钮泄漏）属可接受范围，**对 LLM 抽取无碍**；UI 展示时若想更干净可后置过滤，但别为此改判定逻辑。

### C2. 改 tray-app（三处，按顺序）

**① `packages/tray-app/src/main/capture-types.ts`** —— 给 `CaptureFrameEvent` 补全新字段：
```ts
export interface CaptureStructuredMessage {
  speaker: 'self' | 'other' | 'system'
  name?: string | null
  text: string
}
export interface CaptureFrameEvent {
  // …现有字段保留…
  keepReason?: string
  diffScore?: number
  conversationKind?: 'group' | 'single' | null
  orderNo?: string | null
  messages?: CaptureStructuredMessage[]
}
```

**② `packages/tray-app/src/main/capture-store.ts`** —— 入库改成**直接消费 `frame.messages`**：
- 在 `insertMessageBlocks` / `extractMessages` 处**分叉**：若 `frame.messages?.length`，直接遍历它写 `message_blocks`（`sender_type = speaker`、`content = text`、`name` 可存进现有空闲列或新增 `sender_name`），**复用现有的 `content_hash` 跨帧去重**（`insertMessageBlock` 那套 dedupe 不用动）；只有 `messages` 为空时才退回旧的"整页一条 unknown"。把 `extractMessages(frame, layout)` 这条**旧 VLM 路径视作兜底**，不要再扩展它。
- `conversation_threads`：把 `orderNo` / `conversationKind` 存进去（`ensureColumn('conversation_threads','order_no','TEXT')`、`…'conversation_kind','TEXT'`，已有 `ensureColumn` 机制，加列即可，无需写迁移）。`is_group` 可直接用 `conversationKind === 'group'`。会话标题仍可沿用现有 `upsertConversationThread`，但**有 `orderNo` 时优先用它做 `thread_key`**（`order:<orderNo>`），比按标题哈希更稳。

**③ `capture-sidecar-client.ts`** —— **基本不用动**：`handleMessage` 已对 `type==='frame'` 调 `this.store.insertFrame(message, null, null)`，新字段随 `message` 一起进来；store 改完就生效。（`reconstructAi` / `getLayout` 这些 VLM 残留接口不用管，留着不碍事。）

IPC 与 preload **已就绪、无需改**：`getCaptureConversations(channel?)` → 线程列表、`getCaptureMessages(threadId)` → 带 `senderType` 的消息、`getCaptureScreenshot(path)` → 大图、`getCaptureShots` → 纯磁盘 PNG 兜底（见附录 B4）。UI 直接读这些即可拿到「带说话人」的会话流。

### C3. UI 怎么用这批数据（建议）
- **会话档案/聊天复盘页**：`getCaptureConversations()` 出会话列表（现在能带 `orderNo`/`isGroup`）→ 点进去 `getCaptureMessages(threadId)` 渲染气泡（`senderType=self` 靠右、`other` 靠左、`system` 居中）。
- 想给某订单看「相关沟通」：用线程的 `orderNo`（或后端关联后的 orderId）筛。
- 截图大图：`getCaptureScreenshot(screenshotPath)` 返回 dataURL。

### C4. （可选）上传后端 + 自动关联订单
现在采集是**纯本地**。要让管理后台看到 / 做订单关联，把保留帧上传后端：
1. 截图 PUT 到 MinIO（screenshots bucket）拿 `ossKey`。
2. 对 `frame.messages` 里每条 **other/self** 消息（system 可跳过）调 `POST /api/v1/messages`：
   ```jsonc
   { "channel","conversationName"(=会话标题，最好带 orderNo),
     "senderName"(=message.name),"contentText"(=message.text),
     "screenshotOssKey","capturedAt","employeeId","orderId"? }
   ```
   后端会**自动按 `conversationName` 里的订单号候选做归一+编辑距离≤2 模糊解析**关联订单；解析不到/多单并列 → 写 `unmatched_order_refs` 待确认（员工端用 `GET /api/v1/unmatched-order-refs` + `…/:id/confirm{orderId}` / `…/:id/reject`，详见 §7.0 与 [docs/订单号待确认_交接说明.md](订单号待确认_交接说明.md)）。
3. **注意**：后端 `Message` 是"每条消息一行"。一帧多条 → 循环逐条 POST；或自行加一个"按帧批量存"的端点（按需）。

### C5. （可选，先别自动接）AI 关键信息抽取
攒够一段对话后，把**带说话人的 messages** 发 `POST /api/v1/ai/extract-key-info`：
```jsonc
{ "messages": [{"speaker","name?","text"}, …], "orderContext"?: {customerName,source,hospital,dept,serviceType} }
```
返回 `{ fields:{意向医院/科室/医生/就诊时间/主诉/病情/特殊要求/沟通偏好/其它}, summary, model, raw }`，没有的字段为 `null`、不编造（见 §7.05 / `keyInfoService.ts`）。**接口已建好、可独立调**，但按用户要求**暂不自动触发**——先确认 sidecar 结构化效果，OK 后再决定"攒够消息后端自动抽"还是"员工点按钮抽"。

### C6. 验收 checklist（接完自检）
- [ ] 采集一段真实会话后，`getCaptureMessages(threadId)` 返回的不再是「一条 unknown 大段文本」，而是**逐条带 self/other/system 的消息**。
- [ ] 群聊线程 `isGroup=true`、`orderNo` 已落库（如标题含订单号）。
- [ ] system 行（时间/撤回）单独成条、不污染正文。
- [ ] （如接后端）`POST /api/v1/messages` 能把消息按订单号关联到订单；关联不到的进 `unmatched_order_refs`。
- [ ] tray-app / sidecar 里**没有任何大模型 key 或直连调用**。

### C7. 仍开放的决策（接手前最好和用户确认）
1. **单聊命名规范**：单聊靠备注名里的订单号识别（`客户姓名订单号`，分隔符可有可无）——需用户向寰宇落实命名规范，否则单聊客户可能识别不到。
2. **fwyy（高客）订单号**：后端订单库暂无 fwyy 字段，fwyy 候选当前**必进待确认**；待办是补 fwyy→订单映射（或先按手机号关联）。
3. **群昵称归属**（增强项，未做）：把发送者昵称（如「常远征」）挂到对应 other 消息的 `name`，而不是单独成 [other] 行。需要时在 `MessageStructurer` 里做"昵称行 → 下一条 other 的 name"归并。
4. **是否上传后端 / 何时触发 AI 抽取**：见 C4 / C5，由产品节奏定。
</content>
</invoke>
