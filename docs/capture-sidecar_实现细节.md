# capture-sidecar 实现细节

> 更新时间：2026-06-29
>
> 本文只描述 `packages/capture-sidecar` 当前代码实现，并补充 tray-app 如何启动和消费 sidecar 输出。本文不描述旧版 screenpipe / 全屏截图方案。

## 一、定位与边界

`capture-sidecar` 是 Windows-only 的 C# .NET 8 控制台进程，产物名为 `hyyd-capture-sidecar.exe`。

它负责本机 Windows 原生能力：

- 识别当前前台窗口是否是微信 / 企业微信主窗口。
- 截取目标窗口像素。
- 对关键帧做 OCR。
- 在 sidecar 本地完成聊天区分区、气泡扫描、消息结构化。
- 通过 JSON Lines 协议把状态、错误、帧事件输出给 tray-app。

tray-app 负责：

- 启动 / 停止 sidecar。
- 读取 stdout JSONL 和 stderr 诊断日志。
- 把有效客户会话帧写入本地 SQLite。
- 把结构化消息上报后端。

核心功能不做替代链路：窗口识别、截图、OCR 模型加载、结构化等步骤失败时，应显式报错或随帧带上错误信息供调试，不回退到全屏截图、screenpipe 或其它隐式路径。代码中的 `interval` / `FallbackInterval` 只是“无输入事件时的定时触发”，不是核心步骤失败后的兜底替代。

## 二、工程与构建

代码位置：

- `packages/capture-sidecar/Hyyd.CaptureSidecar.csproj`
- `packages/capture-sidecar/*.cs`

项目配置：

- TargetFramework：`net8.0-windows10.0.19041.0`
- AssemblyName：`hyyd-capture-sidecar`
- 发布方式：Windows 自包含单文件。
- OCR 依赖：`RapidOcrNet`、`SkiaSharp.NativeAssets.Win32`、`System.Drawing.Common`。

构建入口：

- `pnpm sidecar:build:win`
- 实际脚本：`scripts/build-sidecar-win.js`

构建流程：

1. 根据 Windows 机器架构选择 `win-arm64` 或 `win-x64` runtime。
2. 调用 `scripts/ensure-sidecar-ocr-models.js` 确保 RapidOCR 模型存在。
3. 对每个模型文件做 SHA256 校验，不匹配直接失败。
4. 执行 `dotnet publish`。
5. 输出到 `packages/tray-app/resources/capture-sidecar/hyyd-capture-sidecar.exe`。

RapidOCR 模型目录：

```text
packages/capture-sidecar/models/v5/
  ch_PP-OCRv5_det_mobile.onnx
  ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx
  ch_PP-OCRv5_rec_mobile.onnx
  ppocrv5_dict.txt
```

运行时 `RapidOcrEngine` 会从 `AppContext.BaseDirectory/models/v5` 加载模型。缺任何文件都会抛 `FileNotFoundException`，不会切到其它 OCR 引擎。

## 三、进程协议

入口：`Program.cs`

正常 tray 模式下：

1. 设置 stdout / stderr 为 UTF-8。
2. 调用 `NativeMethods.TryEnableDpiAwareness()`，避免 DPI 缩放导致坐标和截图偏移。
3. 创建 `JsonLineWriter` 和 `CaptureCollector`。
4. 向 stdout 写一行 `ready`。
5. 循环读取 stdin，每行一个 JSON 命令。

stdin 命令：

```json
{"type":"ping","requestId":"..."}
{"type":"start","requestId":"..."}
{"type":"stop","requestId":"..."}
```

stdout 消息：

- `ready`：进程可用，协议版本当前为 1。
- `status`：当前是否 collecting。
- `frame`：一帧截图、OCR、结构化结果。
- `error`：显式错误。

stdout 严格用于 JSONL 协议。诊断日志写 stderr，避免污染协议流。

`JsonLineWriter` 内部使用 `SemaphoreSlim` 串行化 stdout 写入，避免后台 worker 和主循环并发写出时打断 JSON 行。

## 四、tray-app 启动方式

入口：`packages/tray-app/src/main/capture-sidecar-client.ts`

Windows 桌面端默认随应用启动 sidecar。只有 `HYYD_ENABLE_SIDECAR=0` 时禁用。

sidecar 路径解析：

1. 如果设置了 `HYYD_CAPTURE_SIDECAR_PATH`，必须指向存在的 exe；不存在直接报错。
2. packaged 模式：`process.resourcesPath/capture-sidecar/hyyd-capture-sidecar.exe`
3. dev 模式：
   - `process.cwd()/resources/capture-sidecar/hyyd-capture-sidecar.exe`
   - `app.getAppPath()/resources/capture-sidecar/hyyd-capture-sidecar.exe`

启动时传入环境变量：

- `HYYD_SAVE_DEBUG=1`：保存截图和 `.debug.json`。
- `HYYD_SAVE_DEBUG=0`：正常模式，OCR 后删除临时截图，不写 debug json。

tray-app 消费规则：

- `ready`：状态变为 ready。
- `status`：更新 collecting。
- `error`：状态变为 error。
- `frame`：
  - 先进入调试环形缓冲。
  - 如果 `filtered=true`，只更新调试状态，不入库不上报。
  - 否则写本地 SQLite，再把结构化消息上报后端。

## 五、采集触发

入口：`CaptureCollector.cs`、`InputEventMonitor.cs`

输入监听在独立后台线程中运行 Win32 message loop，安装：

- `WH_KEYBOARD_LL`：监听键盘。
- `WH_MOUSE_LL`：监听鼠标。
- `EVENT_SYSTEM_FOREGROUND`：监听前台窗口变化。

触发原因：

| reason | 来源 | 用途 |
|---|---|---|
| `foreground` | 前台窗口变化 | 切到微信 / 企微时立即触发 |
| `key-enter` | 回车 | 消息发送后触发 |
| `click` | 鼠标左键松开 | 切会话、点开聊天等 |
| `wheel` | 鼠标滚轮 | 翻历史消息 |
| `interval` | 定时触发 | 无键鼠事件时捕获新消息 |

关键节流参数：

- 首帧重绘等待：`700ms`
- 窗口稳定检查间隔：`150ms`
- 输入尾沿防抖：`200ms`
- 最小截图间隔：`1000ms`
- 打字静默期：`2500ms`
- 定时触发间隔：默认 `5s`，可由 `HYYD_CAPTURE_INTERVAL_SECONDS` 覆盖，要求 `>= 1`

`interval` 触发时，如果最近 `2500ms` 内有非回车按键，会跳过本轮，避免截到尚未发送的半截输入。回车单独触发截图，不受这个限制。

## 六、窗口识别

入口：`WindowInspector.cs`

只识别以下进程：

| 进程名 | channel |
|---|---|
| `WXWork.exe` | `wxwork` |
| `WeChat.exe` | `wechat` |
| `Weixin.exe` | `wechat` |

过滤规则：

- hwnd 为空、不可见、最小化：跳过。
- 获取不到进程：跳过。
- owner window 或 tool window：跳过，避免截到菜单、浮层、弹窗。
- 企业微信只截主窗口 class，默认 `WeWorkWindow`，可用 `HYYD_WXWORK_MAIN_CLASS` 覆盖。
- 微信不限制 class，因为新旧版本主窗 class 不稳定。
- DWM 可见边界优先，失败才用 `GetWindowRect`。
- 过滤微信 / 企微截图工具的全屏遮罩：通过窗口尺寸是否近似主屏或虚拟屏整屏判断。
- 宽高小于 `200px` 的窗口视为弹窗 / 输入法 / 表情窗口，跳过。

窗口标题 `GetWindowText` 只作为窗口元信息，不参与会话标题判断。正式会话标题来自聊天区顶行 OCR。

## 七、截图与稳定性

入口：`WindowCapture.cs`、`CaptureCollector.CaptureOnceIfTargetAsync`

截图前处理：

1. 读取 pending foreground 目标；没有则读取当前前台目标。
2. 若前台不是微信 / 企微，写 `status.collecting=false`。
3. 若窗口 key 变化，认为刚命中目标窗口，写 `status.collecting=true`。
4. hwnd 刚切换时等待 `700ms`，避免 CEF 激活后重绘尚未完成。
5. 截图前重新读取窗口 rect，并间隔 `150ms` 读两次；rect 一致才认为窗口稳定。
6. 窗口切走、channel 不一致、拖动或缩放中，当前轮跳过。

实际截图：

- 使用 `Graphics.CopyFromScreen` 按目标窗口可见 rect 截图。
- 先得到内存 `Bitmap`，不立即落盘。
- 网格采样检查是否接近全黑；黑屏只写诊断日志，不切换截图方案。

落盘只发生在视觉去重决定保留关键帧之后。路径格式：

```text
%LOCALAPPDATA%\HyydCaptureSidecar\frames\yyyy-MM-dd\yyyyMMdd-HHmmss-fff-{channel}-{sha256前12}.png
```

正常模式下，截图只是 OCR 输入临时文件。OCR / 结构化 / 输出完成后，如果 `HYYD_SAVE_DEBUG` 未开启，会尝试删除该 PNG。

## 八、关键帧去重

入口：`FrameSignature.cs`、`FrameDeduplicator.cs`

设计目标：纯视觉去重，不依赖 OCR。只有关键帧才进入落盘、OCR、结构化。

指纹构建：

1. 把截图按比例缩放到固定宽度，默认 `320px`。
2. 转灰度数组，灰度公式近似 `0.299R + 0.587G + 0.114B`。
3. 与历史关键帧指纹比较变化像素比例。

每个 channel 维护独立状态：

- 最近保留的 N 张关键帧指纹，默认 `30`。
- 当前窗口宽高。
- 上次保留时间。

决策规则：

- 首帧：保留，`keepReason=first_frame`。
- 窗口尺寸变化：清空历史并保留，`keepReason=size_changed`。
- 与历史任一帧 diff 小于阈值：跳过，`reason=near_duplicate`。
- 近似重复但距上次保留超过 heartbeat：保留，`keepReason=heartbeat`。
- 与历史帧均不同：保留，`keepReason=visual_changed`。

环境变量：

| 变量 | 默认值 | 含义 |
|---|---:|---|
| `HYYD_CAPTURE_DIFF_THRESHOLD` | `0.002` | 变化像素比例阈值 |
| `HYYD_CAPTURE_PIXEL_THRESHOLD` | `24` | 单像素灰度差阈值 |
| `HYYD_CAPTURE_HEARTBEAT_SECONDS` | `300` | 静止窗口保留心跳帧间隔 |
| `HYYD_CAPTURE_THUMBNAIL_WIDTH` | `320` | 指纹缩略图宽度，最小 64 |
| `HYYD_CAPTURE_DEDUP_HISTORY` | `30` | 每渠道历史关键帧数量，最小 1 |

## 九、后台处理队列

入口：`CaptureCollector.ProcessLoopAsync`

采集循环只做快速操作：

```text
窗口识别 -> 截图到内存 -> 构建指纹 -> 视觉去重 -> 入队
```

后台 worker 串行处理慢操作：

```text
落盘 -> OCR -> 颜色采样 -> 结构化 -> 客户会话判断 -> 输出 frame
```

队列使用 `Channel<CaptureJob>`：

- 有界容量：`3`
- 单写单读
- 队列满时不阻塞采集循环，当前帧丢弃并写诊断日志。

这样切换窗口或快速操作时，采集线程不会被上一帧 OCR 卡住。

## 十、OCR

入口：`OcrEngineFactory.cs`、`RapidOcrEngine.cs`

当前默认 OCR 引擎：

```csharp
OcrEngineFactory.CreateDefault() => new RapidOcrEngine()
```

`WindowsOcr.cs` 仍在代码中，但当前工厂不使用它。

RapidOCR 配置：

- 模型：PP-OCRv5 中文移动版。
- `ReturnWordBox=false`
- `DoAngle=true`
- `TextScore=0.5`

输出：

- `engine = "rapidocr_ppocrv5_ch"`
- `status = "success"`
- `text = result.StrRes`，为空时拼接 blocks 文本。
- `blocks` 使用 OCR 文本块四点框的外接矩形。
- `confidence` 取字符分数平均值，取不到为 null。

OCR 失败处理：

- `CaptureCollector` 捕获异常。
- 写一次 `error`：`OCR 失败（保留该帧，跳过会话过滤）：...`
- 构造 `status="failed"` 的空 OCR payload。
- 该帧继续输出，客户会话判断按“保留”处理，避免 OCR 短暂失败导致漏采。

## 十一、颜色采样

入口：`BlockColorSampler.cs`

OCR 成功且有 blocks 时，sidecar 会为每个 OCR block 采样底色：

1. 对 block bbox 左右扩 `4px`。
2. 网格采样。
3. 跳过亮度小于 `70` 的深色文字笔画。
4. 对剩余像素求 RGB 平均值。

采样结果写入 `OcrBlock.ColorSample`。当前 sidecar 结构化主要靠气泡颜色连通域，不靠 block 采样色判说话人；该字段仍保留给调试和下游分析。

## 十二、消息结构化

入口：`MessageStructurer.cs`

主流程：

```text
OCR blocks
  -> 检测聊天区 x 范围
  -> 过滤聊天区外 blocks
  -> 取聊天区顶行作为标题
  -> 定位输入区 / 发送按钮
  -> 在聊天区扫描气泡连通域
  -> OCR 行归入气泡
  -> 生成 self / other / system 结构化消息
```

### 12.1 聊天区左界

`DetectContactRight` 从窗口左侧 OCR blocks 中推断联系人列表右界：

1. 排除最左图标栏：`minContactX = max(80, width * HYYD_CONTACT_MIN_X_FRAC)`，默认比例 `0.08`。
2. 只取中心点位于窗口左侧区域的 blocks：默认 `< width * 0.40`。
3. 将这些 blocks 视为行，取每行 `MaxX`。
4. 对 `MaxX` 排序并按相邻差距聚类。
5. 选择支持行数最多且达到最小支持数的簇；并列时取更靠右者。
6. `chatX0 = contactRight + HYYD_CHAT_LEFT_PADDING`，默认 `15px`。

找不到符合条件的联系人右界会抛异常。上层会捕获结构化异常，帧仍输出，但 `messages=[]` 且 `structureError` 携带堆栈。

### 12.2 聊天区右界

- 微信：`chatX1 = windowWidth`
- 企业微信：尝试用右侧“企业名片”文字定位成员区左界，作为 `chatX1`。
- 关键词可用 `HYYD_WXWORK_MEMBER_KEYWORD` 覆盖，默认 `企业名片`。
- 找不到时，企业微信也使用 `windowWidth`。

如果 `chatX1 <= chatX0`，直接抛结构化异常。

### 12.3 标题

标题来自聊天区顶栏 OCR：

1. 跳过顶部系统按钮区域，阈值 `max(12, height * 0.018)`。
2. 找内容行最小 `MinY` 作为顶排。
3. 顶排里取 `MinX` 最小的行作为会话标题，避免右上角成员数 / 工具按钮抢占标题。

标题用于：

- `FramePayload.title`
- 客户会话识别
- 申请号候选提取

### 12.4 输入区过滤

为避免把输入框工具栏、发送按钮、草稿内容结构化成消息：

- 企业微信优先识别输入区锚点，默认关键词 `快速会议`，可用 `HYYD_WXWORK_INPUT_ANCHOR` 覆盖。
- 识别“发送”按钮行，丢弃发送按钮同行及其下方 OCR 行。
- 气泡扫描下沿使用发送按钮上方；如果企业微信输入区锚点更高，则进一步收紧。

### 12.5 气泡扫描

扫描范围：

- x：`[chatX0, chatX1)`
- y：标题下方到输入区上方

按渠道分别扫描 self / other 气泡颜色：

| channel | speaker | 基准色 |
|---|---|---|
| `wxwork` | self | `RGB(201,231,255)` |
| `wxwork` | other | `RGB(228,231,235)` |
| `wechat` | self | `RGB(157,242,159)` |
| `wechat` | other | `RGB(238,238,240)` |

颜色容差：

- self：`HYYD_BUBBLE_SELF_TOL`，默认 `16`
- 灰气泡：`HYYD_BUBBLE_GRAY_TOL`，默认 `9`
- 灰色上限：`HYYD_BUBBLE_GRAY_CAP`，默认 `243`

连通域流程：

1. 按颜色生成 mask。
2. 膨胀半径 `3`。
3. 腐蚀半径 `2`。
4. 4 邻域 BFS 找连通域。
5. 过滤面积、宽高和明显非气泡几何形状。
6. 记录 `DebugBubble`，包括无文字的空气泡，供调试页查看。

当前说话人由气泡颜色扫描来源决定：self 色得到 `self`，other 色得到 `other`。

### 12.6 OCR 行归属与 system 消息

当前 RapidOCR 输出已按文本块提供，sidecar 的 `ToLines` 不再二次合并多个词块，而是每个 OCR block 直接作为一行。

归属规则：

- 行中心点落入气泡 bbox 附近，则归入该气泡。
- 同一个气泡内多行按 Y/X 排序后用换行拼接。
- other 气泡会尝试从气泡上方或重叠首行提取群成员昵称。
- 未归入任何气泡、且相对聊天区居中的行，作为 `system`。

system 分类：

- 时间锚点：`kind="time"`
- 群通知 / 系统提示：`kind="notice"`
- 其它居中文案：`kind="other"`

可追加系统关键词：

- `HYYD_CAPTURE_SYSTEM_KEYWORDS`，逗号分隔。

## 十三、客户会话判断

入口：`CaptureCollector.ClassifyTitle`

只看聊天区标题，不看全图 OCR，不看正文。匹配前先删除标题中的所有空白。

群聊关键词：

- 默认：`就医服务群`
- 可用 `HYYD_CAPTURE_TITLE_KEYWORDS` 覆盖，逗号 / 中文逗号分隔。

申请号候选正则：

```regex
[#＃][0-9a-z|]{6,9}(?![0-9a-z|])|fwyy[0-9a-z|]{6,24}|OD[0-9a-z|]{6,24}
```

判断结果：

- 标题含群聊关键词：`isCustomer=true`，`conversationKind="group"`。
- 标题含申请号候选：`isCustomer=true`，若未命中群关键词则 `conversationKind="single"`。
- 两者都不命中：`isCustomer=false`。
- OCR 失败时不做过滤，按客户会话保留该帧。

非客户会话处理：

- `filtered=true`
- 输出 frame 给 tray-app 调试缓冲。
- tray-app 不入库、不上报。
- 若未开启 `HYYD_SAVE_DEBUG`，输出后删除截图。

## 十四、FramePayload

定义：`Models.cs`

关键字段：

| 字段 | 含义 |
|---|---|
| `type` | 固定 `frame` |
| `channel` | `wxwork` / `wechat` |
| `processName` | 目标进程名 |
| `title` | 聊天区顶行 OCR 标题 |
| `capturedAt` | UTC ISO 时间 |
| `window` | 截图窗口位置、尺寸、状态 |
| `screenshotPath` | 本地 PNG 路径 |
| `imageHash` | PNG SHA256，测试图或失败场景可为空 |
| `ocr` | OCR 引擎、状态、全文、blocks |
| `keepReason` | 去重保留原因 |
| `diffScore` | 与历史关键帧最小视觉差异 |
| `conversationKind` | `group` / `single` / null |
| `orderNo` | 标题中提取的申请号候选 |
| `messages` | sidecar 结构化消息 |
| `filtered` | 是否非客户会话，仅供调试 |
| `structureError` | 结构化异常堆栈 |
| `chatX0/chatX1/contactRight` | 分区调试数据 |
| `scanY0/scanY1/bubbles` | 气泡扫描调试数据 |

`messages` 中每条消息包含：

- `speaker`：`self` / `other` / `system`
- `name`：群聊中识别到的对方昵称
- `text`：消息文本，多行用 `\n`
- `kind`：system 细分
- `box/l/r/decidedBy`：调试判据

## 十五、调试与离线模式

### 15.1 standalone

触发方式：

```text
hyyd-capture-sidecar.exe --standalone
```

或：

```text
HYYD_CAPTURE_STANDALONE=1
```

行为：

- 自动 start。
- stdout JSON 静音。
- stderr 打印简洁事件。
- Ctrl+C 退出并打印统计。

### 15.2 test-image

```text
hyyd-capture-sidecar.exe --test-image <png路径>
```

行为：

- 对单张 PNG 跑 OCR。
- 打印 OCR 摘要和 blocks 坐标。
- 根据路径推断 channel。
- 跑颜色采样和 `MessageStructurer.Build`。
- 将结构化消息打印到 stderr。

### 15.3 frame-image

```text
hyyd-capture-sidecar.exe --frame-image <png路径> [--channel wxwork|wechat]
```

行为：

- 对单张 PNG 跑完整 OCR + 结构化。
- 构造一条正式 `FramePayload` 到 stdout。
- 在图片旁写 `<同名>.debug.json`。
- tray-app 调试页的“上传图片测试”使用该模式。

### 15.4 保存调试数据

`HYYD_SAVE_DEBUG=1` 时：

- 保留截图 PNG。
- 在截图旁写同名 `.debug.json`。

未开启时：

- 去重跳过的帧不落盘。
- 保留帧会临时落盘给 OCR 使用。
- 输出 frame 后尝试删除 PNG。

## 十六、环境变量汇总

| 变量 | 默认值 | 位置 | 含义 |
|---|---:|---|---|
| `HYYD_CAPTURE_STANDALONE` | 无 | `Program.cs` | `1` 时进入 standalone |
| `HYYD_SAVE_DEBUG` | `0` | `CaptureCollector.cs` | 保存 PNG 和 debug json |
| `HYYD_CAPTURE_INTERVAL_SECONDS` | `5` | `CaptureCollector.cs` | 定时触发间隔，要求 `>=1` |
| `HYYD_CAPTURE_TITLE_KEYWORDS` | `就医服务群` | `CaptureCollector.cs` | 客户群标题关键词 |
| `HYYD_CAPTURE_DIFF_THRESHOLD` | `0.002` | `FrameDeduplicator.cs` | 视觉去重 diff 阈值 |
| `HYYD_CAPTURE_PIXEL_THRESHOLD` | `24` | `FrameDeduplicator.cs` | 单像素灰度差阈值 |
| `HYYD_CAPTURE_HEARTBEAT_SECONDS` | `300` | `FrameDeduplicator.cs` | 心跳帧间隔 |
| `HYYD_CAPTURE_THUMBNAIL_WIDTH` | `320` | `FrameDeduplicator.cs` | 指纹缩略图宽度 |
| `HYYD_CAPTURE_DEDUP_HISTORY` | `30` | `FrameDeduplicator.cs` | 历史关键帧数量 |
| `HYYD_WXWORK_MAIN_CLASS` | `WeWorkWindow` | `WindowInspector.cs` | 企微主窗口 class |
| `HYYD_CAPTURE_SYSTEM_KEYWORDS` | 内置列表 | `MessageStructurer.cs` | 追加 system 关键词 |
| `HYYD_MSG_CENTER_THRESH` | `0.12` | `MessageStructurer.cs` | 居中 system 判定阈值，当前字段保留 |
| `HYYD_MSG_CENTER_WIDTH` | `0.6` | `MessageStructurer.cs` | 居中 system 最大宽度占比 |
| `HYYD_CHAT_LEFT_PADDING` | `15` | `MessageStructurer.cs` | 联系人右界到聊天区左界 padding |
| `HYYD_CONTACT_MIN_X_FRAC` | `0.08` | `MessageStructurer.cs` | 联系人候选最小 x 比例 |
| `HYYD_CONTACT_MAX_CENTER_FRAC` | `0.40` | `MessageStructurer.cs` | 联系人候选中心点最大 x 比例 |
| `HYYD_CONTACT_RIGHT_MIN_SUPPORT` | `2` | `MessageStructurer.cs` | 联系人右界最小支持行数 |
| `HYYD_CONTACT_RIGHT_TOLERANCE` | `2` | `MessageStructurer.cs` | 联系人右界聚类容差 |
| `HYYD_WXWORK_MEMBER_KEYWORD` | `企业名片` | `MessageStructurer.cs` | 企微成员区左界关键词 |
| `HYYD_WXWORK_INPUT_ANCHOR` | `快速会议` | `MessageStructurer.cs` | 企微输入区上沿关键词 |
| `HYYD_BUBBLE_SELF_TOL` | `16` | `MessageStructurer.cs` | self 气泡颜色容差 |
| `HYYD_BUBBLE_GRAY_TOL` | `9` | `MessageStructurer.cs` | other 灰气泡颜色容差 |
| `HYYD_BUBBLE_GRAY_CAP` | `243` | `MessageStructurer.cs` | 灰气泡 RGB 上限 |
| `HYYD_CAPTURE_SIDECAR_PATH` | 无 | tray-app | 覆盖 sidecar exe 路径，必须存在 |
| `HYYD_ENABLE_SIDECAR` | 非 `0` | tray-app | `0` 时禁用 sidecar |

注意：环境变量读取不到时使用代码默认值。对于部署配置类变量，如 `HYYD_CAPTURE_SIDECAR_PATH`，一旦显式设置但路径不存在，会直接报错，不另找替代路径。

## 十七、失败策略

当前代码的失败策略按阶段区分：

- 命令 JSON 非法：返回 `error`。
- 不支持的命令：返回 `error`。
- sidecar exe 路径不存在：tray-app 抛错并进入 error。
- OCR 模型缺失：RapidOCR 初始化失败，帧报 OCR error。
- OCR 单帧失败：该帧保留并输出 `ocr.status="failed"`，不做客户会话过滤。
- 聊天区分区 / 气泡结构化失败：捕获异常，输出 `structureError`，`messages=[]`，保留原图和 OCR 供调试。
- 非客户会话：不是错误，输出 `filtered=true`，tray-app 不入库不上报。
- 队列满：丢弃当前关键帧并写诊断日志，避免阻塞采集循环。
- 去重判定重复：跳过，不落盘、不 OCR、不输出。

不允许的行为：

- 截不到目标窗口时改截全屏。
- 目标不是微信 / 企微时继续采集其它窗口。
- OCR 引擎或模型缺失时静默切到其它识别路径。
- 环境变量配置错误时绕过配置继续运行。

## 十八、当前实现注意点

- `packages/capture-sidecar/README.md` 仍写着 Windows OCR，但当前工厂默认是 `RapidOcrEngine`。
- `WindowsOcr.cs` 保留在代码中，但不是当前正式链路。
- `packages/tray-app/src/main/capture-types.ts` 的 `ocr.engine` 类型仍只列了旧值，当前 sidecar 实际会输出 `rapidocr_ppocrv5_ch`。这是类型定义与运行时事实不一致的问题。
- `MessageStructurer` 当前在 sidecar 本地完成结构化；部分历史文档或注释提到“结构化移至后端”，需要按当前代码重新核对。
- `CopyFromScreen` 遇到 GPU / CEF 黑屏时当前只诊断，不切换截图 API；如要改为 `PrintWindow` 或其它方案，应先确认方案再改。
