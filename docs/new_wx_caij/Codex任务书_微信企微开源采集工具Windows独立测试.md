# Codex 执行任务书：在 Windows 上独立测试 wechatauto-replica 与 wecom-archive

> 任务编号：HYYD-CHAT-POC-20261024  
> 编写日期：2026-10-24  
> 执行者：在待测 Windows 电脑上运行的 Codex  
> 目标：验证第三方开源项目在当前 Windows / 微信 / 企业微信实际环境中是否能够读取消息及相关媒体。**不与寰宇医道代码集成，不开发正式产品。**

## 0. 请 Codex 从这里开始（执行总指令）

你是本机 Windows 技术测试执行者。请严格按照本文实际操作，**不要只是解释安装方法或写一份方案**。你有本机终端执行权限时，请直接完成环境检查、取得仓库源码、隔离安装、启动和自动化诊断；需要人手操作（登录微信、发送测试消息、点击界面、准许权限）时明确给出一个动作，等待用户完成后继续。

**成功不等于“程序能运行”，而是“从已登录的客户端真正读出当前测试会话的消息，并验证其正确时间、发送者、会话与媒体”。**

完成后在测试根目录输出：

- `environment.md`：OS、CPU 架构、微信/企微精确版本、依赖版本、仓库 commit、安装方式。
- `wechat-test-results.md`：个人微信逐项测试及可核实证据。
- `wecom-test-results.md`：企业微信逐项测试及可核实证据。
- `issues.md`：失败诊断、已采取措施、仍存在的障碍。
- `final-report.md`：结论、候选项目可用程度及后续建议。
- `logs/`：不含敏感凭据及真实聊天全文的安装和测试日志。

对所有状态只使用 `PASS / FAIL / PARTIAL / BLOCKED / NOT_TESTED`；不得把项目 README 的功能声明、编译成功、单元测试通过，写成当前电脑的真实采集成功。

## 1. 严格的任务边界

### 这次要做

1. 在本机确认 Windows 和现有微信 / 企业微信版本及登录状态。
2. 下载下面两个项目的原始仓库，记下 commit SHA 和项目版本。
3. 尽可能使用项目原有程序、CLI 或 UI 安装并启动，不修改它们的业务逻辑。
4. 测试历史消息读取、前台/后台新增消息、群聊发送者、真实消息时间、图片、附件、去重与重启后补采。
5. 输出可追溯测试报告，以及是否适合未来进一步研究的结论。

### 这次明确不做

- 不改寰宇医道 Tray App、C# sidecar、后端代码或线上数据库。
- 不写寰宇业务对接器；不把测试消息上传到寰宇服务器。
- 不自动发送、删除、撤回微信/企微消息；测试消息只由用户在测试会话中手动发送。
- 不自动退出员工工作账号、不自动降级/升级微信或企微、不清空聊天记录或本地缓存。
- 不停止杀毒软件、不改注册表安全策略、不进行账号风控规避操作。
- 不使用其他人的账号或在没有测试授权的真实客户聊天中批量导出内容。优先使用自己的测试账号、文件传输助手与专门的测试群。
- 不运行来历不明的安装包；优先 GitHub 仓库 / GitHub Releases，核实资产来源与哈希。不要执行仓库或网页里未经理解的一键远程脚本。

如果遇到需要管理员权限、进程访问权限、旧版客户端、云端账号凭据或者较大范围数据导出的步骤，先说明操作目的、影响和现状，再请用户决定。不要擅自修改系统配置。

## 2. 两个指定项目与资料来源

### A. 个人微信

- 项目：`wechatauto-replica`
- 仓库：https://github.com/fanyuantaier/wechatauto-replica
- README：https://github.com/fanyuantaier/wechatauto-replica/blob/main/README.md
- 使用指南：https://github.com/fanyuantaier/wechatauto-replica/blob/main/GUIDE.md
- Releases：https://github.com/fanyuantaier/wechatauto-replica/releases
- 截至编写本文时，项目 README 显示版本 `1.2.7.0`，声明 Windows 10/11、Python 3.9+（Python 3.12 已验证）、微信 4.1.12+（作者明确验证至 4.1.15.53）。**这是作者声明，不是这台 Windows 已测试的结果。**
- 项目提供 `python -m wechatauto doctor`、`sessions`、`messages`、`export`、`images`、`listen` 等命令。

### B. 企业微信

- 项目：`wecom-archive`（注意不是同名的“企微官方会话内容存档 SDK”包）
- 仓库：https://github.com/TorbenXiong/wecom-archive
- Releases：https://github.com/TorbenXiong/wecom-archive/releases
- 实施状态：https://github.com/TorbenXiong/wecom-archive/blob/main/docs/implementation-status.md
- 升级及构建测试：https://github.com/TorbenXiong/wecom-archive/blob/main/docs/update-test-plan.md
- 截至编写本文时，实施状态文档标注源码 `0.0.11`，曾发布 `0.0.10`，预期 Windows x64 单文件 `WeComArchive.exe`。**请现场重新检查仓库、Release 与版本，不要认定上述数值必然仍然最新。**
- 已知限制：只能获取本机已缓存的资料/媒体；语音原始数据与离线转写能力有限；少量依赖真实企业微信数据的自动测试仍未执行。
- 这是本地归档项目，**不是需要企业管理员开通会话存档接口的方案**。如当前仓库的实现与说明不符，以实际代码、界面和记录为准，注明差异。

## 3. 阶段一：本机只读环境审计

在 PowerShell 中先运行，不要先升级/降级微信：

```powershell
$PSVersionTable.PSVersion
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture
Get-CimInstance Win32_Processor | Select-Object Name, AddressWidth
Get-Command git, py, python, node, pnpm, cargo, rustc -ErrorAction SilentlyContinue |
  Select-Object Name, Source
Get-Process Weixin, WeChat, WXWork, WeCom -ErrorAction SilentlyContinue |
  Select-Object Name, Id, Path
```

获取微信、企业微信精确版本，优先在“设置 → 关于”查看；可辅助从当前进程的 EXE 文件读取版本（不要从旧的安装包推断当前运行版本）：

```powershell
Get-Process Weixin, WeChat, WXWork, WeCom -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.Path -and (Test-Path $_.Path)) {
    [pscustomobject]@{
      Process = $_.ProcessName
      Exe = $_.Path
      FileVersion = (Get-Item $_.Path).VersionInfo.FileVersion
      ProductVersion = (Get-Item $_.Path).VersionInfo.ProductVersion
    }
  }
}
```

如果文件版本和产品“关于”的版本不一致，在报告中并列记录，不要随意替换。

记录是否正在登录、客户端安装路径、数据目录位置（目录名称可脱敏），以及是否具有正常的历史消息。**不要将现有消息数据库、账号密钥、身份凭证复制到测试目录或日志里。**

创建一个与寰宇项目源码无关的测试根目录：

```powershell
$Root = Join-Path $env:USERPROFILE 'hyyd-chat-poc'
New-Item -ItemType Directory -Force -Path $Root, (Join-Path $Root 'logs'), (Join-Path $Root 'evidence') | Out-Null
Set-Location $Root
```

> 若本机已有同名测试目录，先查看内容，不能覆盖已有测试结果。可新建带日期的子目录。

### 环境检查输出

在 `environment.md` 记录：

| 项目 | 实际值 |
| --- | --- |
| Windows 版本 / 架构 | 待测 |
| 微信运行版本（完整版本号） | 待测 |
| 企业微信运行版本（完整版本号） | 待测 |
| 微信登录状态 | 待测 |
| 企业微信登录状态 | 待测 |
| Git / Python / Node / pnpm / Rust / Cargo | 待测 |
| 测试仓库 Commit SHA | 下载后填入 |
| 是否触碰原客户端版本与数据 | 必须写明 |

## 4. 阶段二：测试个人微信 wechatauto-replica

### 4.1 取得源码并检查版本

优先在独立目录中克隆：

```powershell
$Root = Join-Path $env:USERPROFILE 'hyyd-chat-poc'
Set-Location $Root
git clone https://github.com/fanyuantaier/wechatauto-replica.git
Set-Location (Join-Path $Root 'wechatauto-replica')
git rev-parse HEAD
git status --short
```

若仓库已存在，不要直接 `git reset --hard`；先记录当前状态，用户同意后再更新。阅读当前 `README.md`、`GUIDE.md`、`pyproject.toml` 和相关 Issues。若项目安装方式发生变化，以仓库当前版本为准并记录差异。

### 4.2 Python 独立环境

优先 Python 3.12，若没有则检查项目对本机 Python 的支持。先确认 Python 版本，再创建虚拟环境：

```powershell
py -0p
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -e .
```

如果没有 Python 3.12，可使用满足项目要求的版本，但必须将实际版本写入报告。缺少 Python 时，优先使用官方安装途径，说明安装来源和版本；不得静默覆盖其他项目使用的 Python。

`winsdk`、`pypinyin` 是 README 对发送/UI 辅助路径给出的附加依赖，**优先测试只读功能，诊断明确需要时才安装**；不要为了只读测试先启用发送模块。

安装失败时记录完整错误类别（构建、包不存在、网络或 Windows 权限），不要直接切换到来历不明的轮子或关闭系统安全功能。

### 4.3 功能诊断与第一次读取

在已登录微信的前提下，在源码目录执行：

```powershell
.\.venv\Scripts\python.exe -m wechatauto doctor
.\.venv\Scripts\python.exe -m wechatauto sessions
.\.venv\Scripts\python.exe -m wechatauto messages "文件传输助手"
```

这些命令来自仓库 CLI 说明。若当前 CLI 参数变化，先执行 `python -m wechatauto --help` 和相应子命令的 `--help`，不要自己臆造参数。

**判定规则：**

- `doctor` 能运行：仅算“工具可运行”；不算“消息采集成功”。
- 能列出真实会话：说明会话读取至少部分可用。
- 能读到测试会话消息且与微信 UI 一致：才算“历史文本读取 PASS”。
- 需要分别记录消息时间、发送者、会话标识、消息类型是否可见；别只看消息正文。
- 如果因为缺少账号、数据库路径或进程访问权限失败，写出原始错误摘要、受影响版本、可核查定位，先停止高风险变更。

### 4.4 增量与后台收消息测试

先选用户自己的文件传输助手，或双方明确同意的测试单聊/测试群：

```powershell
.\.venv\Scripts\python.exe -m wechatauto listen "文件传输助手"
```

然后请用户在**另一台自己控制的设备**中，或通过正常客户端操作，手动向这个测试会话发送 3～5 条不同文字。**Codex 不得自行向真实联系人发送测试消息。**

测试分三组：

A. 微信窗口前台打开该会话；
B. 微信仍在线，但切换到另一个会话或最小化；
C. 如果条件允许，客户端重启后，工具重新运行，是否发现重启前未处理的消息。

若 `listen` 只监听指定会话，不要据此推断“所有会话自动监听”；另测是否需要逐个注册会话，以及未打开聊天会话能否被发现。

### 4.5 个人微信媒体测试

使用自己控制的测试会话，准备：

- 1 张清晰图片（例如自制的虚构挂号凭证 PNG）；
- 1 个小型 PDF 文件；
- 1 个 `.docx` 或 `.txt` 文件；
- 可选 1 条语音，前提是项目文档支持该路径。

先通过历史记录确认图片/文件消息存在，再按当前 README / GUIDE 的 `images` 或 `MediaDownloader` 使用方式进行下载。可以先阅读 `python -m wechatauto images --help`。不要把 README 的旧参数当成必然有效。

分别记录：

1. 能否识别消息类型（图片/文件/语音）；
2. 能否找到对应媒体条目与文件名；
3. 能否取得真正可打开的文件；
4. 图片是缩略图、中图还是原图；
5. 微信窗口在后台时，媒体是否能够获取；
6. 媒体未预先下载到本机时，程序是否能识别“缺失”，以及是否需要用户手动打开后才能补齐。

**不要为了下载原图自动点击真实客户会话或批量拉取整个个人微信媒体目录。**

### 4.6 个人微信阶段性结果

使用本文件“统一测试矩阵”中的项目填写 `wechat-test-results.md`，附终端输出的脱敏摘要、测试前后计数、实际命令及退出状态。微信当前版本不在作者实测版本列表内时，明确标记“跨版本实机验证”。

## 5. 阶段三：测试企业微信 wecom-archive

### 5.1 先检查 Releases（推荐路线）

**优先使用项目官方 Release 发布的 Windows x64 文件**，不必先为 Rust / Node 配置完整编译环境。

打开：

https://github.com/TorbenXiong/wecom-archive/releases

Codex 首先确认：

- 实际最新可用 Release 标签、发布时间、是否存在 Windows x64 资产；
- 是否为 `WeComArchive.exe`、带版本号的 `.exe`，还是 `.zip`；
- 资产是否来自指定仓库，是否提供 GitHub digest / SHA-256；
- 发布说明对 Windows、企微版本、启动方式和更新有无新增要求。

如果能取得可信的正式资产，将它下载到单独目录 `hyyd-chat-poc\wecom-archive-release\`，记录 SHA-256 与下载地址：

```powershell
Get-FileHash '实际下载到的EXE或ZIP完整路径' -Algorithm SHA256
```

**不要凭空拼接 Release 文件 URL；也不要从第三方网盘随意下载同名 EXE。**

### 5.2 没有可用 Release 才走源码构建

```powershell
$Root = Join-Path $env:USERPROFILE 'hyyd-chat-poc'
Set-Location $Root
git clone https://github.com/TorbenXiong/wecom-archive.git
Set-Location (Join-Path $Root 'wecom-archive')
git rev-parse HEAD
git status --short
```

先阅读该仓库当前 `README.md`、`package.json`、`Cargo.toml`、`docs/implementation-status.md`、`docs/update-test-plan.md`、实际锁定文件 `pnpm-lock.yaml`、`Cargo.lock` 和交付/验收文档。

项目 0.0.11 文档给出的 Windows 构建基线涉及 Rust `1.98.1`、Node/pnpm 以及锁定依赖，使用过的构建命令包括：

```powershell
pnpm install --frozen-lockfile
pnpm build:client
pnpm build:server
cargo build --release --locked --bin WeComArchive
```

**这些是供核验的候选命令，不是保证可直接执行的万能脚本。** Codex 必须先确认当前仓库工作区布局、脚本名称、Rust 工具链及 native build requirements，再按实际文档执行。如果 Rust Windows 构建需要 Microsoft C++ Build Tools / Windows SDK / WebView2，先检测现有安装，说明缺项后再安装官方工具。

构建结束后确认最终 EXE 的绝对路径、版本、架构及 SHA-256，并使用它做独立测试。不必运行全部测试套件才能判断程序能否打开；如果构建失败，再运行定向测试定位。

### 5.3 确认程序模式，而不是只检查页面是否打开

该项目 0.0.11 文档显示：Windows 单文件 `WeComArchive.exe` 启动后可提供本地 `/api/v1/health` 和工作台页面，首次运行目录可能先出现 `serverData/`，**并不意味着已经采集到企业微信消息**。项目还存在采集端绑定与采集管理流程。

Codex 应完成以下步骤：

1. 在干净的独立目录启动 EXE；记录打开的是浏览器页面、Tauri UI，还是本地服务。
2. 记录监听地址/端口；**不要假设默认是 3000 或 8080**，由程序提示或配置确定。
3. 若有本地服务，按实际地址访问 `/api/v1/health`；记录版本与健康状态。
4. 查看设置/数据源发现/本机采集/手动采集/采集端管理等入口，按照仓库**当前**官方说明执行。
5. 检查程序是否自动发现企业微信本机数据；如未发现，记录实际界面错误，不要随机指定账号目录。
6. 尝试只读地采集一个用户指定的测试会话并在工作台搜索它的消息。
7. 若必须部署采集端，先核对本机单机路径、配置及绑定方法；只有用户同意后才按官方指引创建本机采集端。不要误把多设备远程部署流程当作必须步骤。

能打开页面、健康检查正常、构建成功，仅能说明安装和进程启动成功。**真正的企业微信数据源可读、会话/消息可检索，才算核心采集 PASS。**

### 5.4 企微实际采集测试

仍然使用测试账号或用户指定的测试会话，不要求向泰康申请官方“会话内容存档”。

重点验证：

- 当前企业微信完整小版本能否被支持；
- 是否自动发现本机企业微信数据目录；
- 员工登录但窗口最小化时，新的测试消息是否进入本地数据库；
- 能否区分单聊和群聊、发送者与接收者；
- 导出的时间字段是**原始消息时间**还是**导入归档时间**；
- 相同发送人同一文字连续发两遍，是否留下两条记录；
- 测试图片、PDF、文本文件能否找到并获取；
- 本地未缓存原图时是否提示缺失；
- 关闭和再次运行程序后有无新增消息遗漏、重复或游标异常。

如可从 GUI 导出 JSON / CSV / HTML / PDF，仅针对**测试会话**导出，并检查原始时间、发送人、内容类型与媒体路径。不要导出全量企业数据来证明“工具好用”。

### 5.5 企微阻塞条件

如果项目无法读取当前企微版本，先给出以下事实：当前版本、项目版本、数据源扫描结果、错误日志摘要、仓库最新 Issues/Release 是否已有相关兼容问题。

**禁止 Codex 擅自卸载或回退正在工作的泰康企业微信客户端。** 如确实需要版本对照，单独写明建议的完整版本号、是否有官方可信安装源、回退风险、数据备份需求，并请用户另行批准。当前任务停在可复现的 `BLOCKED` 也是有效结果。

## 6. 统一测试矩阵（两个项目分别填写）

| 编号 | 验收项 | 必须核对的结果 |
| --- | --- | --- |
| T01 | 安装启动 | 程序在本机成功启动，版本和 commit 可追溯 |
| T02 | 账号发现 | 找到本机已登录的实际账号，不混淆其他配置 |
| T03 | 会话列表 | 能看到当前测试会话 |
| T04 | 历史文字 | 测试会话中至少 10 条已知消息能够读取 |
| T05 | 新消息发现 | 前台新消息能够被读取 |
| T06 | 后台新消息 | 微信/企微窗口不在前台时能够被读取 |
| T07 | 原始时间 | 有消息级发送时间，不只是截图/导入时间 |
| T08 | 消息顺序 | 依据真实消息顺序可正确排列 |
| T09 | 发送者 | 单聊发送方、群聊具体成员正确 |
| T10 | 重复文本 | 连发相同文字不会被误合并 |
| T11 | 图片 | 能识别图片消息，标明原图/缩略图/缺失 |
| T12 | 文件 | 能识别并取得 PDF / DOCX 或 TXT 测试文件 |
| T13 | 客户端重启 | 重新启动后不会因固定水位漏采 |
| T14 | 工具重启 | 再次运行不制造明显重复数据 |
| T15 | 断网后恢复 | 有可观测的补采和失败提示，不虚报成功 |
| T16 | 无界面依赖 | 新消息读取是否依赖激活或打开对应聊天窗口 |

每个测试项必须记录：`状态`、`输入步骤`、`实际结果`、`证据文件/日志行`、`限制或原因`。

测试文本可使用：

- `HYYD-POC-A-001`、`HYYD-POC-A-002`；
- 连续两次发送完全相同的 `HYYD-POC-DUP`；
- 带有年月日和时间的自制图片、测试 PDF 和 TXT 文件；
- 发送时用本机时钟记录真实时间，并与读取到的原始消息时间比较。

**验收重点不是导出了多少条历史消息，而是 4 个核心指标：能否不打开目标会话持续收新消息；是否有可靠原始时间；是否能区分发送者；是否能正确关联图片/文件。**

## 7. 常见失败场景与处理策略

| 现象 | Codex 先做什么 | 不得直接做什么 |
| --- | --- | --- |
| Python 安装失败 | 核查 Python 版本、pip 报错、pyproject 依赖 | 覆盖系统 Python |
| 个人微信 doctor 找不到数据库 | 检查登录状态、客户端版本、项目指南、实际路径配置 | 随意解锁系统权限或上传数据库 |
| 个人微信只能读旧消息 | 检查项目增量机制、测试会话及轮询水位 | 宣称后台实时采集通过 |
| 图片只有缩略图 | 核对本机缓存状态、项目媒体规则 | 把缩略图标成原图 |
| 企微 EXE 能打开但无数据 | 确认工作台/采集端、数据源发现、扫描任务状态 | 宣称采集成功 |
| 企微无法编译 | 核对 Build Tools、Rust、pnpm 与锁定依赖 | 随意修改锁文件掩盖问题 |
| 当前客户端不兼容 | 搜索明确版本支持记录，汇报可复现结果 | 自动降级正在使用的客户端 |
| 运行期间报敏感日志 | 本地保存时先脱敏，必要时仅记错误码和堆栈位置 | 将密钥/全文贴到共享 issue |

## 8. 最终报告模板（final-report.md）

```markdown
# Windows 微信 / 企业微信采集 PoC 报告

## 1. 测试机器
- Windows：
- 微信版本：
- 企业微信版本：
- 测试日期：

## 2. 个人微信 wechatauto-replica
- 源码版本 / Commit：
- 安装是否成功：PASS/FAIL/PARTIAL/BLOCKED
- 历史文字读取：
- 后台新增消息：
- 原始发送时间：
- 群聊发送者：
- 图片 / 文件：
- 实际可用结论：可用 / 部分可用 / 不可用 / 未验证
- 关键限制：

## 3. 企业微信 wecom-archive
- Release 或源码版本 / Commit：
- 安装是否成功：
- 本地企业微信数据源发现：
- 历史文字读取：
- 后台新增消息：
- 原始发送时间：
- 群聊发送者：
- 图片 / 文件：
- 实际可用结论：可用 / 部分可用 / 不可用 / 未验证
- 关键限制：

## 4. 两个项目的统一测试矩阵
| 用例 | 微信 | 企微 | 证据 |
| --- | --- | --- | --- |
| T01-T16 | 逐项填写 | 逐项填写 | 对应日志 |

## 5. 遇到的问题与已实施修复
| 项目 | 具体错误 | 操作 | 操作后结果 |
| --- | --- | --- | --- |

## 6. 是否建议继续深入研究
- 个人微信：
- 企业微信：
- 若失败，最接近成功的障碍是什么：
- 需要用户额外执行的动作：
- 是否需要单独对照旧版客户端（不得自动执行）：

## 7. 可复现性
- 实际执行过的命令：
- 取得源码 / 发布物的来源：
- 已核对的哈希与版本：
- 未测试的项目：
```

## 9. 给 Codex 的执行顺序与完成条件

1. **先环境检查**：收集实际精确版本，不先变更客户端。
2. **先 wechatauto-replica**：已有 CLI，先跑 `doctor` → `sessions` → `messages` → `listen`，验证是否能从微信读到真实测试消息。
3. **再 wecom-archive**：先检查官方 Release 单文件是否存在；如可用先执行，缺少时再考虑源码构建；随后按工作台与采集端配置进行真实数据读取验证。
4. **需要用户配合时，提出精确动作**：例如“现在请向文件传输助手发送 `HYYD-POC-A-001`，完成后告诉我”，不要猜测已经发生了某个动作。
5. **发现不可解决的兼容问题如实停止当前分支**，并继续另一项目；不要为了追求 PASS 随意替换微信版本、修改系统设置或重写第三方核心。
6. **产出最终报告和文件路径**。实际做到哪一步就写到哪一步；禁止将未执行操作描述成成功。

### 终极通过标准

- **个人微信 PASS**：不依赖打开目标聊天窗口，能够在本机读取测试会话历史和新增消息；消息时间、发送者可核对；图片与文件的可用/缺失状态可信。
- **企业微信 PASS**：无需泰康管理员的会话存档权限，使用当前已登录客户端，在本机读取指定测试会话消息；时间与发送者正确；媒体读取能力得到真实测试结果。
- 如果仅可导出历史、不能持续增量；或者只能依赖前台窗口，则标记 **PARTIAL**，并说明实际能力，而不是简单判为 PASS。

---

## 10. 参考资料核查提示

这份任务书基于 2026-10-24 能读取到的仓库 README / 使用指南及项目测试文档制定。GitHub 内容可能更新，所以 Codex 执行前需要核对当前 README、Release、完整版本号和必要依赖。尤其 `wecom-archive` 的 Release 资产、启动端口、采集端绑定流程，必须以**本机下载到的实际版本**为准，不能硬编码想象中的命令。

原始资料：

- https://github.com/fanyuantaier/wechatauto-replica
- https://github.com/fanyuantaier/wechatauto-replica/blob/main/GUIDE.md
- https://github.com/TorbenXiong/wecom-archive
- https://github.com/TorbenXiong/wecom-archive/blob/main/docs/implementation-status.md
- https://github.com/TorbenXiong/wecom-archive/blob/main/docs/update-test-plan.md
