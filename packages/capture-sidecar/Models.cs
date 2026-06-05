namespace Hyyd.CaptureSidecar;

internal sealed record TargetWindow(
    string Channel,
    string ProcessName,
    string WindowTitle,
    WinRect Rect,
    string ShowState
);

internal sealed record CaptureRect(int X, int Y, int Width, int Height);

internal sealed record OcrBlock(string Text, CaptureRect Bbox, double? Confidence);

internal sealed record OcrPayload(string Engine, string Status, string Text, IReadOnlyList<OcrBlock> Blocks);

internal sealed record WindowPayload(int Left, int Top, int Width, int Height, string ShowState);

internal sealed record FramePayload(
    string Type,
    string Channel,
    string ProcessName,
    string? WindowTitle,
    string CapturedAt,
    WindowPayload Window,
    string ScreenshotPath,
    string? ImageHash,
    OcrPayload Ocr,
    string KeepReason,
    double DiffScore
);

