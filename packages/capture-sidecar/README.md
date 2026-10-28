# Hyyd Capture Sidecar

Windows-only helper process for WeChat/WeCom capture.

The Tray App owns UI, local SQLite, upload, and lifecycle. This sidecar owns the
Windows-native surface:

- foreground window detection for `WXWork.exe` and `WeChat.exe`
- target-window screenshot capture
- `Windows.Media.Ocr` OCR with word/line bounding boxes
- JSON Lines IPC over stdin/stdout

The sidecar must not fall back to full-screen capture or screenpipe. If a core
step fails, it returns an explicit `error` message to the Tray App.

## 微信大图探针

在 Windows 上运行：

```powershell
hyyd-capture-sidecar.exe --probe-windows
```

探针只识别微信（`Weixin.exe` / `WeChat.exe`）的大图窗口，不参与聊天消息采集。大图识别使用 Windows UI Automation 控件树：优先检查窗口根控件 `ImagePreviewWnd`，同时检查大图工具栏控件（上一张、下一张、放大/缩小、翻译、提取文字、二维码识别等）。不依赖固定 hwnd、窗口标题或窗口尺寸。

识别到大图后，探针仍然使用窗口屏幕截图保存 PNG，不执行“另存为”。每次鼠标事件和大图候选事件会在 `probe-events.jsonl` 中记录 UIA 根控件类型、className、Name、命中的控件名称和错误信息，便于在不同微信版本上确认实际控件树。

正式聊天消息采集仍由 `CaptureCollector` 独立负责，暂不消费探针事件。
