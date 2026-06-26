# AI 交接 · 当前状态（v2 新 UI + 管理后台 + 笔记本迁移）

> ⚠️ **2026-06-26 状态更正（接手的 AI 先读这段——本文下文有几处已过时）**
> - **后端已迁到阿里云 ECS `47.95.14.233`，服务端口 `9093`**（WS `/ws`、HTTP、插件自动更新都在这个端口）。本文下文「后端在 Mac:13000 + Windows VM/笔记本走内网连 Mac」是早期本地开发期的部署，已过时；MinIO 也在该 ECS（19000）。本地开发仍可跑 13000。
> - **截图 OCR 已从 Windows.Media.Ocr 换成 RapidOCR（PP-OCRv5 / ONNX Runtime）**——见 [`采集管道_实现细节.md`](采集管道_实现细节.md)。本文 §9/§10 里「WindowsOcr」表述已过时。
> - **消息结构化（拼行/分气泡/判说话人）现在仍在 sidecar(C#) 里做，后端不再做结构化**。[`变更说明_结构化移至后端.md`](变更说明_结构化移至后端.md) 描述的「移到后端」后来已回退，以 [`采集管道_实现细节.md`](采集管道_实现细节.md)（2026-06-16）为准。
> - **工作台/详情主颗粒度已从「订单」改为「申请号 `crmApplyNo`」**——以 [`工作台页面功能说明.md`](工作台页面功能说明.md) 为准（本文 §4 提到的 4 泳道按订单是旧版）。

> **写作时间：2026-06-12（最后更新 2026-06-15）**　**面向：接手本项目的下一个 AI**
>
> 这是 [`TRAYAPP_AI_交接文档.md`](TRAYAPP_AI_交接文档.md) 的**当前状态续篇**。
> - 业务背景、铁律、环境命令、capture-sidecar/微信采集 → **读那份**（不在此重复）。
> - 本次会话（v2 扶正成 Electron、管理后台 admin-web 从 0 建完、无边框标题栏、登录页、DPI 教训、VM→笔记本迁移）→ **读这份**。
> - **2026-06-15 补充**：采集完整管道（§9）、采集调试页重做（§10）。
>
> **如果你只读一段**：现在有三个前端（`admin-web` 管理后台 / `tray-app v2` 新采集 UI / `tray-app v1` 旧采集 UI 已退役）。v2 已经是 Electron 桌面应用的界面，但**只换了外壳，剪贴板采集能力还没从 v1 移植过来**——这是下一个主线任务。同时正在把部署目标从「Mac 上的 Windows VM」迁到「一台真实荣耀笔记本」。

---

## 1. 三个前端的全景

| 前端 | 路径 | 是什么 | 跑在哪 | 状态 |
|---|---|---|---|---|
| **admin-web** | `packages/admin-web` | 管理后台（老板远程看采集情况），纯网页 | 与后端同一台机（生产 ECS / 现在 Mac） | ✅ 本次从 0 建完（设计见 `docs/寰宇医道_管理后台设计.md`） |
| **tray-app v2** | `packages/tray-app/src/renderer/src/v2` | **新**采集工具 UI（员工用） | 员工 Windows（现 VM，迁笔记本中） | 🚧 已 Electron 化，但**只换外壳**，采集能力未移植 |
| **tray-app v1** | `packages/tray-app/src/renderer/src/{pages,components}` | **旧**采集工具 UI | —— | 🗄 退役。保留作代码参考，以后只在浏览器看（`pnpm --filter tray-app dev:v2` 是 v2 预览，不是 v1） |

**三者关系**：admin-web 是独立产品（只读后端数据），跟 tray 无关。v2 是 v1 的继任者——v1 强依赖 Electron IPC（剪贴板/本地 sqlite/capture），v2 是 web-first 重做的（纯 HTTP）。"扶正 v2"= 让 Electron 桌面应用加载 v2 而非 v1。

---

## 2. 后端速览 + 本次新增

后端在 **Mac 上**（Fastify，`packages/backend`），员工端/笔记本通过网络访问。**后端改动不用 deploy 到员工机**。

- 入口 `src/index.ts`；员工端 REST 在 `src/routes/api.ts`；DB = PostgreSQL via Prisma（`prisma/schema.prisma`）；对象存储 = MinIO。
- 端口：后端 **13000**（`.env` PORT，监听 0.0.0.0）；MinIO **19000**；Postgres **15432**。
- 启动：`pnpm backend:dev`（tsx watch，改 .env 要重启；改 .ts 会热重载）。

**本次会话后端新增**（都已对真实数据验证）：
1. `src/routes/admin.ts`（~1170 行）：管理后台全部接口，独立 **JWT cookie 鉴权**（密码 `ADMIN_PASSWORD`，现为 `321`）。挂 `/api/v1/admin/*`。
2. `src/routes/adminBus.ts`：管理后台 WS 实时推送总线（`broadcastAdmin`）。
3. `index.ts`：注册 `@fastify/cookie`、`/ws/admin`（JWT 握手）、`@fastify/static` 把 admin-web `dist/` 挂到 `/admin/*`（生产托管）。
4. `routes/api.ts`：员工鉴权 hook 放行 `/api/v1/admin` 与 `/admin`；素材/通话创建时 `broadcastAdmin`；`/me/presence` 写 `trayRestSeenMap`（Tray 在线心跳，见 §6 坑）。
5. **OrderStatusHistory**（用户自己加的 schema + ORDERS_SYNCED 对比逻辑）：admin `orders/:id/full` 已带上 `statusHistory`，订单详情页渲染状态时间线。

> 管理员密码、JWT 密钥在 `packages/backend/.env`：`ADMIN_PASSWORD` / `ADMIN_JWT_SECRET`。

---

## 3. admin-web（管理后台）

**技术栈**：React 19 + Vite + TanStack Query/Table + Recharts + Tailwind v4。复用 tray 的 Claude 暖白主题（强调色 `#B8902E`）。

**页面**（`src/pages/`，全部建完，无占位）：Dashboard / Employees / EmployeeDetail(4 Tab) / Orders(绿通·挂号两 Tab) / OrderDetail(泰康字段铺平+附件+素材/通话时间线+状态历史+JSON) / Materials(主从客户切换) / MaterialDetail / Calls(未关联订单红标+筛选) / Health / Login / Settings。

**运行**：
```bash
pnpm backend:dev                 # 后端 13000
pnpm --filter admin-web dev      # 前端 5174，/api 与 /ws 代理到 13000
```
开 http://localhost:5174 ，密码 `321`。生产：`pnpm --filter admin-web build` → 后端把 `dist/` 挂 `/admin/*`，开 http://localhost:13000/admin/ 。

**鉴权**：`POST /api/v1/admin/login` → httpOnly cookie；其余 `/api/v1/admin/*` 需 cookie，401 前端自动弹回登录。

**状态**：MVP 设计文档要求的页面 100% 完成（含 WS 实时推送、系统健康全字段、订单状态历史）。选做项（导出/脱敏/审计/多管理员）**用户明确说不做**。详见 `packages/admin-web/README.md`。

---

## 4. tray-app v2（新采集 UI）—— 重点

### 4.1 现状：已"换外壳"，采集能力未移植
用户选择「只换外壳」：Electron 桌面应用现在加载 v2 界面（替掉 v1），登录/工作台看板/订单详情等 **HTTP 功能可用**。但 v1 的**剪贴板粘贴采集、本地 sqlite 暂存、离线同步**（`window.api.*`、`src/main/material-*`、`capture-*`）**还没接进 v2**——v2 现在只读不采。**这是下一个主线任务。**

### 4.2 Electron 如何加载 v2（本次改动）
- `electron.vite.config.ts`：renderer 入口 `build.rollupOptions.input = src/renderer/index-v2.html`。
- `src/main/index.ts`：`mainWindow.loadFile('../renderer/index-v2.html')`（dev 用 `${ELECTRON_RENDERER_URL}/index-v2.html`）。
- v2 入口：`index-v2.html`（`#v2-root`）→ `src/renderer/src/v2/main.tsx` → `App.tsx`。
- v1 的 `index.html` 原样保留（不再被 Electron 加载，留作浏览器参考）。

### 4.3 v2 文件地图（`src/renderer/src/v2/`）
- `main.tsx` / `App.tsx`：根；App 顶部挂 `TitleBar`，下方按登录态切 `LoginPage` / `AppShell`(工作台) / `OrderDetailPage`。
- `api.ts`：**纯 fetch**，无 Electron 依赖。**后端地址写死**（见 §5）。
- `components/TitleBar.tsx`：**自绘标题栏**（见 4.4）。`components/AppShell.tsx`：登录后带顶部导航的壳。
- `pages/`：`LoginPage.tsx`（医院走廊配图 base64 内联）、`WorkbenchKanban.tsx`（泳道看板）、`OrderDetailPage.tsx`。
- `assets/loginHero.ts`：登录配图，base64 data URI（见 §6 坑）。
- `styles.css`：v2 独立设计令牌（Trust Blue 主色，与 v1 互不影响）；含 `.app-drag`/`.app-no-drag` 拖拽区。
- `lib/orderMapping.ts`：泰康字段映射。

### 4.4 无边框窗口 + 自绘标题栏（本次新增）
- 主进程 `frame: false`（去掉 Windows 原生标题栏）。
- IPC：`window:minimize`/`window:hide`/`window:maximize-toggle`/`window:is-maximized` + maximize/unmaximize 事件 `window:maximized-changed`。
- preload（`src/preload/index.ts`）暴露 `minimizeWindow/hideWindow/maximizeToggle/isMaximized/onMaximizedChanged`。
- `TitleBar.tsx`：左品牌（双击最大化）+ 右三键（最小化/最大化·还原/**关闭=隐藏到托盘**，沿用 tray 行为，托盘菜单"退出"才真退）。浏览器预览无 `window.api` 时不渲染。
- 三个页面根从 `h-screen` 改 `h-full`，让出标题栏高度。

### 4.5 浏览器预览 v2（仅 UI 迭代用）
`pnpm --filter tray-app dev:v2` → http://localhost:5180 （`vite.v2.config.ts`，纯网页，无 Electron）。⚠️ **但验证 tray-app 一律走 deploy + 真机手测，不要用浏览器预览代替**（见 §6）。

---

## 5. 部署 & VM→笔记本 迁移（进行中）

### 5.1 deploy:win 工作流
改完 `tray-app/extension/shared-types/capture-sidecar` 后跑 `pnpm deploy:win`（`scripts/deploy-win.js`）：SSH 传源码 → 远端 `pnpm install` + `electron-vite build` + 重建 extension/sidecar → taskkill 旧进程 → `pnpm tray:dev` 拉起。详见 deploy-win skill。

> ⚠️ 脚本"detached 后台拉起"在旧 VM 上**不稳**（常没留住进程）。真机若没自动出窗口，让用户在目标机终端手动 `cd <目标目录> && pnpm tray:dev`。

### 5.2 迁移到荣耀笔记本（后端仍在 Mac，笔记本走公司内网连 Mac）
**笔记本要装**：OpenSSH Server（22 端口，最关键，我远程部署/看日志靠它）、Node ≥20（本机 24.x，22 LTS 也行）、**pnpm 9.15.9**（`package.json` packageManager 锁死，corepack 装最准）、.NET 8 SDK（capture-sidecar `net8.0`）、Chrome。详细命令见聊天记录最后几条。

**要改的写死地址**（旧 VM 网段 `192.168.202.1`，笔记本连不到，需换成 Mac 的内网 IP）：
| 文件:行 | 内容 | 改成 |
|---|---|---|
| `packages/tray-app/src/renderer/src/v2/api.ts:14` | `BACKEND_URL='http://192.168.202.1:13000'` | Mac 内网 IP:13000 |
| `packages/backend/.env` `MINIO_PUBLIC_HOST` | `192.168.202.1` | Mac 内网 IP（否则附件/录音/图片 presigned 裂） |
| `.env` `WIN_VM_HOST/USERNAME/PASSWORD/TARGET_DIR` | 指向旧 VM | 指向笔记本 |
| `.env` `GATEWAY_BASE_URL` | `http://192.168.202.1:8080` | 若用 blackwhite Gateway，改 Mac 内网 IP |

> Mac 候选内网 IP：`192.168.99.165`（公司网，DHCP 可能变——建议路由器给 Mac 绑固定 IP）。Mac 防火墙要放行 13000/19000 入站。
> **待用户提供**：笔记本内网 IP、Windows 用户名/密码、目标目录 → 然后一次性改上面四处并 `deploy:win` 验证。

### 5.3 真正发布（未来）
`pnpm package:win`（`scripts/build-installer-win.js`）/ `pnpm --filter tray-app build:win`（electron-builder）出 .exe 安装包，目标机只装 exe、不需要 node/pnpm/.NET。现在迭代期用的是 dev 模式（源码 + tray:dev）。

---

## 6. 关键决策与坑（务必知道）

1. **tray-app 验证只走「deploy:win → 真机手测」，不要用浏览器预览**。tray 是 Electron 应用，跑在员工机；浏览器预览（dev:v2 / Claude Preview）只适合 admin-web 这类纯网页。（已写入 AI 记忆。）
2. **DPI/缩放教训**：旧 VM 是 3024×1696 @ **200% 缩放** → 逻辑分辨率仅 1512×848，导致界面"显大显松"。这**不是设计松**，是缩放放大。曾加 `zoomFactor 0.85` 去糊，**已撤掉**——因为真机笔记本是 100~125%，那样会过小。**密度要在真机（1920×1080 @ 100%，逻辑=物理）上判断**；真要调密度就改设计 token（`styles.css` 字号/间距），别用全局 zoom。窗口默认 `1280×800`/min `1024×640`。
3. **后端地址写死、不可配置**：是用户明确要求（员工机固定连一个后端，不给配置界面）。所以 §5.2 改地址是改源码常量，不是加配置。
4. **登录配图必须本地**：原型用的 `lh3.googleusercontent.com/aida-public/...` 是会过期的临时链接（已裂）。现已从 `docs/stitch_ui_interface_design/login/screen.png` 裁出走廊照片、压成 29KB JPEG **base64 内联**进 `assets/loginHero.ts`（零远程依赖）。⚠️ 但 v2 的**字体/图标仍走 Google Fonts CDN**（`index-v2.html` 引 Inter + Material Symbols）——离线/无外网环境会裂，**这是个未解决的隐患**，以后要本地化字体。
5. **deploy detached 不稳**（§5.1）。
6. **改 tray 后必 typecheck 再 deploy**：`pnpm --filter tray-app typecheck`（node+web），因为 `build:win` 会先 typecheck，提前发现免得部署卡住。
7. **协作协议**（`/Users/xipilabs/dev/CLAUDE.md`）：小步、变更前先确认。用户是产品/业务方，技术决策给建议+让他拍板。
8. **远程访问目标机**：用 `.env` 的 SSH 凭证 + 根目录 `node_modules/ssh2`（写个临时 .cjs 从仓库根跑）。注意 Windows 默认 cmd shell、GBK 编码（中文输出会乱码，用 `chcp 65001` 或只看 ASCII）。

---

## 7. 待办（建议优先级）

1. **【主线】把 v1 采集能力移植进 v2**：剪贴板粘贴素材（`window.api.clipboardRead` + `materialsAddText/Image`）、本地 sqlite 暂存（`src/main/material-store.ts`）、离线同步（`material-sync.ts`）。v2 的工作台/订单详情要加"粘贴素材"入口。参考 v1 `components/MaterialPanel.tsx`。
2. **【运维】完成笔记本迁移**：用户给 IP/凭证后改 §5.2 四处地址 + `deploy:win` 验证。
3. **【真机调密度】** 在 1920×1080 @100% 笔记本上看 v2，若仍松则改 `styles.css` 设计 token。
4. **【隐患】v2 字体/图标本地化**（Google Fonts CDN 离线会裂，§6.4）。
5. v2 其余 Tab（待申领/客户档案/知识库/数据看板）目前是占位（`App.tsx` Placeholder），按 `docs/寰宇医道_最终功能版_功能设计.md` 逐页接入。
6. 管理后台选做项**不做**（用户已确认）。

---

## 8. 速查

```bash
# 后端（Mac）
pnpm backend:dev

# 管理后台
pnpm --filter admin-web dev          # 5174，密码 321
pnpm --filter admin-web build        # → 后端 /admin/* 托管

# tray-app v2
pnpm --filter tray-app typecheck     # 改完先查
pnpm deploy:win                      # 部署到员工机（改 tray 必做）
pnpm --filter tray-app dev:v2        # 5180 浏览器预览（仅 UI 迭代，不算验证）

# 远程目标机：SSH 凭证在根 .env 的 WIN_VM_*
```

**关键文档**：本文 + `运维手册_SSH与应用发布.md`（SSH/部署 runbook）+ `TRAYAPP_AI_交接文档.md`（背景/铁律/采集）+ `寰宇医道_管理后台设计.md` + `寰宇医道_最终功能版_功能设计.md`（v2 功能设计）。

**AI 记忆**（`~/.claude/projects/.../memory/`）：deploy:win 工作流、LLM 走 Gateway 凭证 等。

---

## 9. 采集完整管道（2026-06-15 补充）

> TRAYAPP_AI_交接文档.md §6 有早期采集设计，这里记录**当前实际实现**，以实际代码为准。

### 9.1 管道全景（每一帧的生命周期）

```
[触发]                 键鼠/前台事件 → 尾沿防抖 600ms → 最小间隔 1s → CaptureOnceIfTargetAsync
   ↓
[C# 去重]              FrameSignature（缩略图哈希）→ diff < 阈值 → 跳过（Diag: 跳过·近似重复 diff=X）
   ↓（不重复）
[OCR]                  WindowsOcr → 全窗口 OCR（包含侧边会话列表 + 聊天区 + 输入框等所有区域）
   ↓
[客户会话过滤]          去全部空白后 regex 匹配：
                        - 命中"就医服务群"关键词 → 群聊，保留
                        - 命中 fwyy…/COD…/CCOD…/OD… 订单号 → 单聊，保留，抽 orderNo
                        - 两者都没有 → 非客户会话，删盘（截图文件 TryDelete），不上报
   ↓（保留帧）
[C# 分区+结构化]        DetectChatXRange（X 投影→列检测→取最宽密集列=聊天区）
                        + 顶 8%/底 10% 裁（标题栏/输入框）
                        → 分行→分气泡→判说话人（颜色饱和度为主/左右位置兜底）
                        结果进 FramePayload.messages（供 sidecar debug 展示；TS 侧另行处理）
   ↓
[stdout] FramePayload JSON → tray-app 主进程
   ↓
[TS 后端结构化]         POST /api/v1/capture/structure
                        发：全窗口 OCR 词块（含 colorSample）+ 窗口宽高
                        后端：同样的 DetectChatXRange + 分行分气泡判说话人（TS 移植版）
                        返：StructMessage[] {speaker, name, text}
   ↓
[TS 本地入库]           capture-store.ts insertFrame
                        - 帧级去重：imageHash + ocrTextHash（DB 级，防 C# 漏网的重复帧）
                        - 按订单号/手机号/标题 建/更新 conversation_threads
                        - 逐条 insertMessageBlock（内容哈希去重，2min 窗口内相同内容算同一条）
                        → 返回 newMessages（本次新增的消息块列表）
   ↓（有新消息）
[TS 上报后端]           uploadNewMessages：对每条 newMessage 逐条 POST /api/v1/messages
                        发：channel, conversationName, senderType, contentText, capturedAt, orderNoCandidate
                        后端：
                          1) 有 orderNoCandidate → OCR 归一(O→0/l→1…) + 编辑距离≤2 模糊匹配员工订单
                          2) 解析不到 → 存 UnmatchedOrderRef（待员工确认）
                          3) 无 orderNoCandidate → 按 conversationName 模糊匹配"已申领/进行中"订单
                          存 messages 表（PostgreSQL）
                          返：{data: message, _debug: {matchMethod, candidate, dist, matchedOrderId}}
```

### 9.2 三处去重的区别

| 位置 | 算法 | 目的 |
|---|---|---|
| C# `FrameDeduplicator` | 缩略图像素哈希 diff < 阈值 | 避免截"几乎没变"的画面（高频触发时省 CPU/OCR/存储） |
| TS `insertFrame` | imageHash + ocrTextHash（SQLite） | DB 级幂等：C# 偶尔漏网的重复帧在 TS 层拦截 |
| TS `insertMessageBlock` | 内容哈希 + 2min 窗口 | 同一消息出现在多帧中只存一次（消息级去重） |

### 9.3 分区（聊天区检测）

**动态列检测**（`DetectChatXRange`，C# 和后端 TS 各一份，算法相同）：
- 对全窗口所有 OCR 词块，把 X 坐标投影成"覆盖直方图"
- 扫描连续空白竖条（≥18px 无文字），切成若干列
- 取"词块数≥5 的列里最宽的" = 聊天区
- 天然排除：图标栏 / 会话列表 / 右侧成员面板 / 工具栏，不受窗口大小/成员面板开合影响
- 还额外裁顶 8%（标题栏）、底 10%（输入框）

**传给后端的是全窗口词块**（`frame.ocr.blocks` 含所有区域），后端的 `structureMessages` 自己做一遍列检测过滤。C# 侧做的那遍结构化只用于 sidecar 本地调试展示（`FramePayload.messages` → debug 帧中可见），不作为上报数据。

### 9.4 消息上报到底上报什么

`POST /api/v1/messages` 每次上报**一条消息**，字段：
- `channel`：wechat/wxwork
- `conversationName`：会话标题（微信好友名/群名）
- `senderType`：self/other（由结构化判定的说话人）
- `senderName`：说话人昵称（群聊中对方名字；目前结构化暂不提取，为 null）
- `contentText`：消息正文（已去重归一）
- `capturedAt`：截图时间
- `orderNoCandidate`：从整屏 OCR 抽到的订单号原文（容忍 OCR 误差；后端做归一+编辑距离匹配）

后端不做消息拼装，收到的是单条已结构化消息，只做"挂到哪个订单"。

### 9.5 已知问题 / 下一步

- **非客户会话误丢**：OCR 识别到订单号里有字符被误读（如 `O→〕`），正则匹配失败 → 误判为非客户会话删盘。需要更宽松的正则或在正则前做 OCR 噪点替换。
- **消息说话人 name 为空**：群聊里对方昵称目前不提取（`StructMessage.name = null`），只有 self/other。
- **纯图片/语音消息漏采**：OCR 无文字时整帧视为空，对方发的图片/语音不进消息流。
- **左侧会话列表误命中**：过滤时全图 OCR 匹配，若列表中有其他群名恰好命中关键词，会保留非活跃会话的帧（列检测会过滤掉侧栏消息，但帧不会被丢弃）。

---

## 10. 采集调试页（2026-06-15 重做）

`packages/tray-app/src/renderer/src/v2/pages/SidecarDebugPage.tsx`

**重写为步骤流水线视图**（替代原来的原始日志列表）：

- **左侧**：捕获事件列表（最新在前），一行 = 一次截图尝试，显示渠道/时间/触发原因/结果
- **右侧**：选中事件展开 7 步流水线（① 触发 ② 截图&去重 ③ OCR ④ 客户会话判断 ⑤ 本地入库 ⑥ 后端结构化 ⑦ 上报后端），每步有彩色指示条

**数据来源**：`getDiagLogs`（diagLog 文字日志）+ `getCaptureDebugFrames`（保留帧，含截图路径）两路合并，纯前端解析，不改 C# 协议。

**OCR 文本显示**：中文字符间的空格（Windows OCR 逐字拆开的 artifact）被 `compactCJK()` 去掉，显示可读文本。

**截图**：保留帧有截图（从 `保留关键帧 ... → path` 日志提取路径，与 debugFrame 比对），非客户/去重跳过显示"截图已删"。
