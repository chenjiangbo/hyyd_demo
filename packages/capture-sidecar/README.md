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

