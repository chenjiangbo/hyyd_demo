# Windows 测试环境及可复现信息

测试日期：2026-10-24（Asia/Hong_Kong）。本文为本轮最终状态；早期诊断日志中的“安装失败/未测试”属于测试过程中的阶段状态，最终实测以此报告和 `final-report.md`、`wechat-test-results.md` 为准。

## 本机环境

| 项目 | 最终确认结果 |
|---|---|
| Windows | Windows 10 Pro；`Get-ComputerInfo` 版本 10.0.19045；PowerShell 7.6.5。受限 CIM 查询未成功取得系统架构字段。 |
| 微信 | `C:\\Program Files\\Tencent\\Weixin\\Weixin.exe`；EXE/ProductVersion 4.1.15.56（用户于 2026-10-24 更新后实测）。此前基线测试使用 4.1.15.13；本轮没有自动升级/降级。 |
| 微信进程会话 | 登录用户桌面 session 1 中运行。默认 Codex 受限执行用户最初无法枚举该用户进程；用户明确同意后，在登录用户会话进行本机只读诊断。 |
| Python | 测试目录内 Python 3.12.10 x64；项目独立虚拟环境 `.venv312`。系统既有 Python 3.13.4 未替换；原 `python.exe` WindowsApps 别名未用于本次成功测试。 |
| wechatauto-replica | 官方仓库源码 ZIP 快照；版本 1.2.7.0。Git 未安装，无法核对完整 commit SHA。 |
| 依赖 | 安装完成；包括 winsdk 1.0.0b10、pywin32 312、uiautomation 2.0.29、Pillow 13.0.0、cryptography 50.0.2、OpenCV 5.0.0.93 等。详见 `logs/pip-install.log`。 |
| 数据库可读性 | doctor 找到微信并验证 24/24 个数据库可解密。报告不保存数据库密钥/账号凭据。 |
| UI Automation | doctor 未取得预期 UIA 控件树。数据库历史读取和新增消息监听实测成功；需要通过界面点击下载的媒体流程尚未验证。 |
| 企业微信 | `C:\Program Files (x86)\WXWork\WXWork.exe`，EXE/ProductVersion 5.0.13.6005；用户原已启动并登录。没有自动升级/降级。 |
| 寰宇医道代码 | 未访问或修改项目代码。 |

## wechatauto-replica 安装过程

1. 下载官方 ZIP 源码，解压到 `sources/wechatauto-replica-main/`。该快照版本为 1.2.7.0。ZIP 哈希见 `logs/download-hashes.txt`；无 Git，未取得 commit SHA。
2. Python 3.13.4 下安装时，`winsdk` 没有适用预编译轮子，pip 进入源码构建并因缺少 Visual Studio/NMake 等编译工具失败。
3. 用户接受使用另一个 Python 环境后，下载 Python 3.12.10 x64 到测试根目录 `python312/`。安装器 SHA-256：`67B5635E80EA51072B87941312D00EC8927C4DB9BA18938F7AD2D27B328B95FB`。系统 Python 3.13.4 保持不变。
4. 在源码目录 `.venv312/` 创建虚拟环境；将 pip cache 放在测试目录，完成项目和依赖安装。完整日志 `logs/pip-install.log`。
5. CLI 成功启动。初次运行的 doctor 在 Codex 受限账户下因无权看到登录用户的微信进程而误报“未检测到 Weixin.exe”。用户同意后切换到其登录 Windows 用户会话进行只读诊断，doctor 找到微信并验证数据库解密。

## wecom-archive 检查结果（2026-10-24 增补）

- 官方仓库 ZIP 版本 0.0.11；Release 资产未能在网页界面载入可核验 EXE。按源码锁定要求在测试输出目录准备 Node v24.20.0、pnpm 10.30.3、Rust 1.98.1 x86_64-pc-windows-msvc；不替换全局工具链。pnpm frozen-lockfile 安装完成，锁文件未改。
- 使用 VS2019 Build Tools 16.11.47、MSVC 14.29.30133、Windows SDK 10.0.19041.0 完成 `pnpm build:client`、`pnpm build:server` 和 `cargo build --release --locked --offline --bin WeComArchive`。
- 测试副本：`wecom-test-run/WeComArchive.exe`，0.0.11、x64、8,864,768 字节，SHA-256 `2232187C099547CC038687754FD3D3183C127179D33FE9563BD85EBDB6951E1F`。测试目录初始只有 EXE。
- 用户授权后已启动。应用在旁边创建独立 `serverData/`，服务监听 `127.0.0.1:9812`，初始化日志为 `loopback_only`；UI 显示 0 条消息、0 项媒体、0 个会话。当前为空归档，不代表企微没有消息或程序已经识别了本机数据源。
- 实际企微客户端已从运行进程/文件版本确认：`C:\Program Files (x86)\WXWork\WXWork.exe`，5.0.13.6005；没有自动升级/降级。用户手动触发两次本机采集，状态均 completed；最终归档 2,958 条消息/117 会话/88 媒体引用。第二次扫描后新增 1 条、未变 2,951 条、修订 6 条。SQLite integrity_check=ok。媒体 38 项通过 hash/size，50 项标记为授权目录未找到；详见 `wecom-test-results.md`。
- UI 无障碍树可以读取；自动截图两次报 `window capture timed out: timed out waiting on channel`，点击“会话”控件失败 `coordinate input geometry is unavailable`。未盲目继续点控件。一次历史采集已通过；增量与原生顺序、媒体全量读取仍待进一步验证。详见 `wecom-test-results.md`。

## 数据与权限边界

- 用户明确同意在登录微信的 Windows 用户会话执行本机只读诊断。工具需要读取微信进程内存中的密钥以解密本机数据库；doctor 显示 24/24 可解密。测试读取 filehelper 历史及增量消息。
- 真实聊天正文、数据库副本和密钥没有放入交接报告。日志保留测试所需的标记和时间；转交外部开发前，项目负责人可按交付政策进一步脱敏。
- 图片证据保存在 `evidence/`。附件 PDF 没有复制到测试报告目录；只记录用户提供路径中的文件存在、字节数和 PDF 文件头检查结果。
- 没有升级/降级微信或企微，没有修改客户项目代码。

