# 寰宇采集 Android MVP

这是移动端 MVP 工程，用于华为工作手机侧载安装，采集通话记录和系统通话录音。

## 当前范围

- 前台服务保活
- `CallLog` 增量读取
- 常见通话录音目录扫描
- 调后端 `POST /api/v1/calls`
- 调后端 `POST /api/v1/recordings` 获取 MinIO presigned URL
- 直接 `PUT` 上传录音文件

## 现场版配置

服务器地址和员工 ID 在 App 的“设置”页手工输入。`app/build.gradle.kts` 只保留默认后端地址，员工 ID 默认留空：

```kotlin
buildConfigField("String", "BACKEND_URL", "\"http://192.168.99.165:13000\"")
buildConfigField("String", "EMPLOYEE_CODE", "\"\"")
```

后端通过 `X-Employee-Code` 关联三端身份，Android 端不传 `employeeId`。

## 安装前手机设置

1. 电话设置里开启通话自动录音。
2. 安装 APK 后授予通话记录、电话状态、音频读取权限。
3. Android 11+ 需要授予“全部文件访问权限”，否则可能读不到系统录音目录。
4. 在华为系统设置里允许自启动、后台运行，并关闭电池优化。

## 构建

用 Android Studio 打开 `packages/android-app`，同步 Gradle 后构建 APK。

开发测试可以用 debug 包。发给员工安装时必须用 release keystore 签名，且后续升级必须继续使用同一个 keystore。
