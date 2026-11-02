# Windows 客户端本机打包说明

本文供在 Windows 电脑上工作的开发者和 Codex 使用，目标是生成可安装的 Windows x64 客户端。使用当前工作区源码，包括尚未提交的修改；需要拉取其他人的代码时，先由开发者明确决定。本文不操作生产环境，不会发布后台。

安装包包含客户端、浮动精灵、微信采集器和企微采集器。微信和企微采集器都要在打包机上编译并打进同一个安装包；客户安装后不需要安装 Python、Rust 或 C++ 编译工具。

## 1. 首次准备环境

使用 Windows x64、PowerShell，以及项目的完整源码。首次构建需要下载依赖；后续构建可以复用已安装环境和构建缓存。以下工具是打包机的开发环境，不需要安装在客户电脑上。

1. **Node.js x64**：安装 Node.js 24 x64。已有打包机使用 Node.js 24.22.1。下载入口：[Node.js 官方下载](https://nodejs.org/en/download)。仓库的包管理器是 **pnpm 9.15.9**。
2. **Python 3.12.10 x64**：安装 [Python 3.12.10 Windows 64 位版本](https://www.python.org/downloads/release/python-31210/)。请安装带 `pip` 的标准版本，并启用 Python Launcher。微信采集器的构建环境与机器上其他 Python 项目分开。
3. **Visual Studio Build Tools**：在 [Visual Studio 官方下载页](https://visualstudio.microsoft.com/downloads/)安装 Build Tools 或已安装的 Visual Studio，勾选“使用 C++ 的桌面开发”，确保安装 MSVC x64/x86 C++ 生成工具和 Windows SDK。**这是当前企微 Rust 采集器编译所需，不是旧截图方案的依赖**；`better-sqlite3` 也可能需要原生模块构建环境。
4. **Rust / Cargo**：通过 [Rust 官方安装方式](https://rust-lang.org/tools/install/)安装 rustup，并选择 Windows MSVC 工具链。项目 `packages/native-chat-collectors/wxwork/vendor/upstream/rust-toolchain.toml` 当前指定 Rust **1.98.1** 和 `x86_64-pc-windows-msvc`；版本变化时以仓库文件为准。
5. **网络与权限**：首次需要访问 npm、Python 包、Rust 工具链及 crates、Electron/NSIS 下载源。下载安装工具需要的权限按各自安装程序处理；构建本身不应以 `C:\Windows\System32` 作为当前目录。

安装完成后重新打开 PowerShell，先切换到你自己的项目根目录。例如项目在 `D:\work\hyyd_demo` 时：

```powershell
Set-Location 'D:\work\hyyd_demo'
```

确认当前位置是项目根目录（能看到 `pnpm-workspace.yaml`）：

```powershell
Test-Path .\pnpm-workspace.yaml
```

应输出 `True`。之后本文命令都在这个 PowerShell 和项目根目录执行。每条命令都是独立的一行；上一条失败时先解决错误，不要继续下一步。

检查版本与系统位数：

```powershell
node --version
```

```powershell
py -3.12 -c "import sys,struct; print(sys.version.split()[0], struct.calcsize('P')*8)"
```

Python 应输出 `3.12.10 64`。如果安装了多个 3.12 版本，先用 `py -0p` 找到 Python 3.12.10 x64 的完整路径，后文创建虚拟环境时用该路径代替 `py -3.12`，不要更改其他项目的 Python 环境。

```powershell
rustup --version
```

启用并验证 pnpm（若 Node 发行包没有 Corepack，可先执行 `npm install --global corepack`）：

```powershell
corepack enable
```

```powershell
corepack prepare pnpm@9.15.9 --activate
```

```powershell
pnpm --version
```

应输出 `9.15.9`。若命令找不到，先重新打开 PowerShell；若有公司网络代理或权限限制，按实际错误配置环境，不要修改其他项目的工具链。

安装当前 Rust 版本与目标：

```powershell
rustup toolchain install 1.98.1 --profile minimal
```

```powershell
rustup target add x86_64-pc-windows-msvc --toolchain 1.98.1
```

Windows 上的 `cargo`、`rustc` 与 MSVC 需要都是 x64。企微构建脚本会通过 Visual Studio Installer 自动查找并加载 MSVC 环境；普通 PowerShell 中 `cl` 暂时不在 PATH，并不代表脚本一定无法工作。

## 2. 安装项目依赖

在项目根目录运行：

```powershell
pnpm install --frozen-lockfile
```

依赖应与仓库的 `pnpm-lock.yaml` 一致。如果锁文件与源码不一致或下载失败，先检查实际错误；不要悄悄修改锁文件、跳过失败，或继续使用旧依赖制作安装包。

此步骤安装项目所需依赖；本文随后只构建 Windows 客户端和两个采集器，不构建 Android 应用或 Chrome 插件。

## 3. 编译微信采集器

使用单独的构建虚拟环境。若 `HyydWechatBuild-3.12.10` 已存在，先确认它确实属于本项目且使用 Python 3.12.10 x64；不要覆盖其他项目的环境。首次创建：

```powershell
py -3.12 -m venv "$env:LOCALAPPDATA\HyydWechatBuild-3.12.10"
```

```powershell
& "$env:LOCALAPPDATA\HyydWechatBuild-3.12.10\Scripts\python.exe" -c "import sys,struct; print(sys.version.split()[0], struct.calcsize('P')*8)"
```

应输出 `3.12.10 64`，否则停止并处理解释器版本。

```powershell
& "$env:LOCALAPPDATA\HyydWechatBuild-3.12.10\Scripts\python.exe" -m pip install --only-binary=:all: -r .\packages\native-chat-collectors\wechat\requirements-windows.txt
```

```powershell
New-Item -ItemType Directory -Force -Path "$env:LOCALAPPDATA\HyydWechatBuild-3.12.10\spec" | Out-Null
```

```powershell
& "$env:LOCALAPPDATA\HyydWechatBuild-3.12.10\Scripts\python.exe" -m PyInstaller --noconfirm --onefile --name hyyd-wechat-collector --specpath "$env:LOCALAPPDATA\HyydWechatBuild-3.12.10\spec" --paths "$PWD\packages\native-chat-collectors\wechat\vendor" --collect-all cryptography --collect-all zstandard --workpath "$env:LOCALAPPDATA\HyydWechatBuild-3.12.10\work" --distpath "$env:LOCALAPPDATA\HyydWechatBuild-3.12.10\dist" .\packages\native-chat-collectors\wechat\collector.py
```

确认构建命令成功结束、没有错误后，再复制生成文件：

```powershell
Copy-Item "$env:LOCALAPPDATA\HyydWechatBuild-3.12.10\dist\hyyd-wechat-collector.exe" '.\packages\native-chat-collectors\wechat\hyyd-wechat-collector.exe' -Force
```

```powershell
Get-Item '.\packages\native-chat-collectors\wechat\hyyd-wechat-collector.exe' | Select-Object FullName,Length,LastWriteTime
```

仓库也有 `packages/native-chat-collectors/wechat/prepare-runtime.ps1`；它会删除并重建微信采集器目录下的 `.runtime-build`。若选择运行该脚本，应先确认该目录没有需要保留的内容；不要把项目以外的 Python 环境当作临时目录删除。

## 4. 编译企微采集器

在项目根目录运行项目脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File '.\packages\native-chat-collectors\wxwork\build-windows.ps1'
```

脚本会查找 Visual Studio 的 MSVC 工具链、执行 `cargo build --locked --release`，并生成：

```powershell
Get-Item '.\packages\native-chat-collectors\wxwork\hyyd-wxwork-collector.exe' | Select-Object FullName,Length,LastWriteTime
```

首次构建要下载 Rust 依赖，可能较慢。`warning: unused ...` 等警告不等同于失败；必须看到构建成功且命令退出成功。若提示找不到 `vswhere.exe`、MSVC 或 `cargo.exe`，先检查第 1 节的安装项，不要复制旧采集器冒充新构建。

## 5. 生成 Windows 安装包

每次交付新安装包时，在 `packages/tray-app/package.json` 中把 `version` 更新为尚未使用的新版本号，并保留其他内容；例如上一版为 `1.0.24` 时，下一版可使用 `1.0.25`。确认后继续。版本号是项目源码的一部分，不要让不同内容共用同一个交付版本号。

先构建客户端（包含主进程、界面、浮动精灵和类型检查）：

```powershell
pnpm --filter tray-app build
```

成功后生成 Windows x64 安装程序：

```powershell
pnpm --filter tray-app exec electron-builder --win --x64
```

打包钩子会检查两个采集器可执行文件是否存在；如果缺失，回到第 3、4 节重新构建。安装包生成后查看当前版本的文件（命令只显示最新生成的安装包，仍须先确认上面的打包命令成功）：

```powershell
Get-ChildItem '.\packages\tray-app\dist\*-setup.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 FullName,Length,LastWriteTime
```

正常文件名类似 `寰宇智能助手-1.0.25-setup.exe`，位于 `packages\tray-app\dist`。目录可能保留旧版本，因此不要看到多个 `setup.exe` 就认为都由本次生成；按版本号和生成时间确认。

可把确认过的安装包复制到 Windows 下载目录，方便手工测试。以下命令中的文件名必须替换为本次实际生成的名称：

```powershell
Copy-Item '.\packages\tray-app\dist\寰宇智能助手-1.0.25-setup.exe' "$env:USERPROFILE\Downloads\tray-app-1.0.25-setup.exe"
```

记录安装包校验值（替换为本次实际名称）：

```powershell
Get-FileHash "$env:USERPROFILE\Downloads\tray-app-1.0.25-setup.exe" -Algorithm SHA256
```

## 6. 确认包含本次采集器

在构建成功后，分别确认打包目录中的采集器与本次构建产物哈希一致：

```powershell
Get-FileHash '.\packages\native-chat-collectors\wechat\hyyd-wechat-collector.exe', '.\packages\tray-app\dist\win-unpacked\resources\native-chat-collectors\wechat\hyyd-wechat-collector.exe' -Algorithm SHA256 | Format-Table Hash,Path -AutoSize
```

```powershell
Get-FileHash '.\packages\native-chat-collectors\wxwork\hyyd-wxwork-collector.exe', '.\packages\tray-app\dist\win-unpacked\resources\native-chat-collectors\wxwork\hyyd-wxwork-collector.exe' -Algorithm SHA256 | Format-Table Hash,Path -AutoSize
```

每条命令的两行 `Hash` 应相同。如果不同、文件不存在或安装包版本不对，停止交付，查明原因并重新打包。

安装包只更新 Windows 客户端；后台接口或管理页面改动需要单独部署。构建成功也不代表真实采集验收通过，交付前需在 Windows 上实际安装，并结合后台验证微信、企微及相关业务流程。

## 7. 常见问题

- **提示 `.spec` 没有写入权限**：确认 PowerShell 当前目录是项目根目录，PyInstaller 命令的 `--specpath` 指向上述用户目录；不要在 `C:\Windows\System32` 或 Visual Studio 安装目录运行。
- **Python 提示模块缺失**：确认执行的是上述专用虚拟环境中的 `python.exe`，并重新检查依赖安装结果；不要把系统其他 Python 环境中的包当成本次已安装。
- **企微编译卡在最后几项**：Rust release 编译和链接可能需要数分钟；查看任务管理器里 `cargo`、`rustc` 或链接进程是否仍在工作。若失败，保留完整错误日志定位。
- **Electron / NSIS 下载失败**：先检查本机网络、代理和 Electron 官方下载源可达性。不要因为存在旧安装包就宣称本次成功。
- **打包后安装器提示客户端无法关闭**：先正常退出正在使用的客户端，再重试安装；不要为了编译自动关闭微信、企微或其他项目进程。
