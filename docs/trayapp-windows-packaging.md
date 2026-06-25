# TrayApp Windows 打包说明

## 目标

生成 Windows x64 安装包，并把桌面端安装包、Chrome 插件和 Android APK 汇总到 Windows VM 的发布目录。

当前测试环境后端地址：

```text
http://47.95.14.233:9093
```

## Windows VM

连接信息来自项目根目录 `.env`：

```text
WIN_VM_HOST=192.168.20.174
WIN_VM_PORT=22
WIN_VM_USERNAME=chenj
WIN_VM_TARGET_DIR=C:\Users\chenj\hyyd_demo
```

发布目录：

```text
C:\Users\chenj\hyyd_demo\release-windows
```

## 打包流程

1. 在 macOS 本地确认 trayapp 能通过类型检查和生产构建。

```bash
pnpm --filter tray-app build
```

2. 同步当前源码到 Windows VM，并在 VM 上安装依赖、重建原生模块、构建插件和采集 sidecar。

```bash
pnpm deploy:win
```

关键检查点：

- `better-sqlite3` 必须显示 `arch=x64`。
- `capture-sidecar` 必须显示 `runtime=win-x64`。
- 如果任一步失败，不继续后续打包。

3. 在 Windows VM 上停止旧桌面进程后生成安装包。

```powershell
cd C:\Users\chenj\hyyd_demo
pnpm sidecar:build:win
cd C:\Users\chenj\hyyd_demo\packages\tray-app
pnpm exec electron-builder install-app-deps --arch=x64
pnpm exec electron-vite build
pnpm exec electron-builder --win --x64
```

安装包输出：

```text
C:\Users\chenj\hyyd_demo\packages\tray-app\dist\tray-app-1.0.0-setup.exe
```

整理到发布目录时重命名为：

```text
C:\Users\chenj\hyyd_demo\release-windows\tray-app-1.0.0-setup-win-x64.exe
```

## Chrome 插件

本地需要保留签名私钥：

```text
packages/extension/key.pem
```

打包命令：

```bash
node scripts/pack-extension.js
```

产物：

```text
packages/extension/release/huanyu-extension.crx
packages/extension/release/update.xml
```

## Android App

后台地址配置在：

```text
packages/android-app/app/build.gradle.kts
```

当前值：

```kotlin
buildConfigField("String", "BACKEND_URL", "\"http://47.95.14.233:9093\"")
```

打包命令：

```bash
cd packages/android-app
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home ./gradlew assembleDebug
```

产物：

```text
packages/android-app/app/build/outputs/apk/debug/app-debug.apk
```

发布目录中命名为：

```text
huanyu-collector-android-debug.apk
```

## 发布目录内容

每次最终发布至少包含：

```text
tray-app-1.0.0-setup-win-x64.exe
tray-app-1.0.0-setup-win-x64.exe.blockmap
latest.yml
huanyu-extension.crx
update.xml
huanyu-extension-dist.zip
huanyu-collector-android-debug.apk
```

## 常见问题

- 普通国内 Windows 笔记本通常使用 x64，不要发布 arm64 安装包。
- 如果安装后提示 `better_sqlite3.node is not a valid Win32 application`，说明原生依赖架构不匹配，需要重新执行 `pnpm exec electron-builder install-app-deps --arch=x64` 后再打包。
- 如果快捷方式找不到 `tray-app.exe`，优先确认安装包架构是否为 x64，并确认 NSIS 配置允许选择安装目录。
